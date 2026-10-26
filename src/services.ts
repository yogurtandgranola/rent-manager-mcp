import { RentManagerClient, RentManagerError, rql, rqlValue } from "./rent-manager-client.js";
import type {
  AgingResult,
  ChargeType,
  DelinquencyRecord,
  HistoryItem,
  Lease,
  Property,
  RecurringCharge,
  RentManagerConfig,
  RentRoll,
  RentRollRow,
  ServiceManagerIssue,
  Tenant,
  Transaction,
  Unit,
  UnitType,
} from "./types.js";

/** An error whose message is meant for the user as-is (not found, ambiguous match, bad input). */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

// Field lists taken from the Rent Manager SDK examples. If an instance rejects
// one of them, the client retries the request without a field list.
const PROPERTY_FIELDS = ["PropertyID", "Name", "ShortName", "IsActive"];
const TENANT_FIELDS = [
  "TenantID",
  "TenantDisplayID",
  "Name",
  "FirstName",
  "LastName",
  "Email",
  "PropertyID",
  "UnitID",
  "IsActive",
  "CurrentBalance",
];
const UNIT_FIELDS = ["UnitID", "PropertyID", "Name", "UnitNumber", "UnitTypeID", "IsActive"];
const LEASE_FIELDS = ["LeaseID", "TenantID", "UnitID", "PropertyID", "MoveInDate", "MoveOutDate"];

const CONCURRENCY = 5;
const MAX_AGING_LOOKUPS = 250;

// ── Pure helpers (exported for tests) ──

export function normalize(text: string | number | null | undefined): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tenantName(t: Tenant): string {
  const full = [t.FirstName, t.LastName].filter(Boolean).join(" ").trim();
  return t.Name?.trim() || full || `Tenant #${t.TenantID}`;
}

export function unitLabel(u: Unit | undefined): string {
  if (!u) return "-";
  return u.Name?.trim() || u.UnitNumber?.trim() || `Unit #${u.UnitID}`;
}

function datePart(value: string | null | undefined): string | null {
  const match = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return match ? match[1] : null;
}

export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Rent Manager stores local times without a zone suffix. */
function localDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function transactionType(tx: Transaction): string {
  return String(tx.TransactionType ?? tx.Type ?? "");
}

/**
 * Converts a ledger transaction to its effect on what the tenant owes:
 * charges are positive, payments and credits negative. Rent Manager may send
 * payment amounts as positive numbers, so the sign is taken from the type.
 */
export function signedAmount(tx: Transaction): number {
  const amount = Number(tx.Amount) || 0;
  if (/payment|credit|receipt|concession|discount|write ?off/i.test(transactionType(tx))) return -Math.abs(amount);
  return amount;
}

function isPayment(tx: Transaction): boolean {
  return /payment|receipt/i.test(transactionType(tx));
}

export function sortTransactions(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    const byDate = String(a.TransactionDate ?? "").localeCompare(String(b.TransactionDate ?? ""));
    return byDate !== 0 ? byDate : (a.TransactionID ?? a.ID ?? 0) - (b.TransactionID ?? b.ID ?? 0);
  });
}

export interface LedgerRow {
  tx: Transaction;
  date: string | null;
  type: string;
  signed: number;
  running: number;
}

export function buildLedger(txs: Transaction[]): LedgerRow[] {
  let running = 0;
  return sortTransactions(txs).map((tx) => {
    const signed = signedAmount(tx);
    running = round2(running + signed);
    return { tx, date: datePart(tx.TransactionDate), type: transactionType(tx) || "-", signed, running };
  });
}

/**
 * Estimates aging by applying all payments and credits to the oldest charges
 * first. Rent Manager allocates payments to specific charges, so the buckets
 * are an approximation; the total open amount still equals the ledger balance.
 */
export function computeAging(txs: Transaction[], asOf: string): AgingResult {
  const charges: Array<{ date: string; open: number }> = [];
  let credit = 0;
  let lastPayment: Transaction | null = null;

  for (const tx of sortTransactions(txs)) {
    const signed = signedAmount(tx);
    if (signed > 0) charges.push({ date: datePart(tx.TransactionDate) ?? asOf, open: signed });
    else credit += -signed;
    if (isPayment(tx)) lastPayment = tx;
  }

  for (const charge of charges) {
    if (credit <= 0) break;
    const applied = Math.min(charge.open, credit);
    charge.open -= applied;
    credit -= applied;
  }

  const buckets = { current: 0, days31to60: 0, days61to90: 0, over90: 0 };
  let oldestUnpaidDate: string | null = null;
  for (const charge of charges) {
    if (charge.open < 0.005) continue;
    oldestUnpaidDate ??= charge.date;
    const age = daysBetween(charge.date, asOf);
    if (age <= 30) buckets.current += charge.open;
    else if (age <= 60) buckets.days31to60 += charge.open;
    else if (age <= 90) buckets.days61to90 += charge.open;
    else buckets.over90 += charge.open;
  }

  return {
    buckets: {
      current: round2(buckets.current),
      days31to60: round2(buckets.days31to60),
      days61to90: round2(buckets.days61to90),
      over90: round2(buckets.over90),
    },
    oldestUnpaidDate,
    daysPastDue: oldestUnpaidDate ? Math.max(0, daysBetween(oldestUnpaidDate, asOf)) : 0,
    lastPaymentDate: lastPayment ? datePart(lastPayment.TransactionDate) : null,
    lastPaymentAmount: lastPayment ? Math.abs(Number(lastPayment.Amount) || 0) : null,
  };
}

/** Strips "Lot", "Unit", "#" and leading zeros so "Lot 007" matches "7". */
function unitKey(text: string | undefined): string {
  return normalize(text)
    .replace(/^(lot|unit|site|space|spc|apt|home|no|number)\s*/, "")
    .replace(/^0+(?=\d)/, "")
    .replace(/\s+/g, "");
}

export function matchUnit(units: Unit[], input: string): Unit[] {
  const wanted = unitKey(input);
  if (!wanted) return [];
  const keys = (u: Unit) => [u.Name, u.UnitNumber].filter((k): k is string => Boolean(k)).map(unitKey);
  const exact = units.filter((u) => keys(u).includes(wanted));
  if (exact.length) return exact;
  return units.filter((u) => keys(u).some((k) => k.includes(wanted)));
}

export function monthlyAmount(charge: RecurringCharge): number {
  const amount = Number(charge.Amount) || 0;
  const freq = String(charge.FrequencyType ?? charge.Frequency ?? "").toLowerCase();
  if (/bi-?week|every 2 weeks|fortnight/.test(freq)) return (amount * 26) / 12;
  if (/week/.test(freq)) return (amount * 52) / 12;
  if (/semi-?month|twice a month/.test(freq)) return amount * 2;
  if (/quarter/.test(freq)) return amount / 3;
  if (/semi-?annual|half/.test(freq)) return amount / 6;
  if (/annual|year/.test(freq)) return amount / 12;
  if (/day|daily/.test(freq)) return (amount * 365) / 12;
  return amount;
}

function isChargeActive(charge: RecurringCharge, today: string): boolean {
  const start = datePart(charge.FromDate ?? charge.StartDate);
  const end = datePart(charge.ToDate ?? charge.EndDate);
  if (start && start > today) return false;
  if (end && end < today) return false;
  return true;
}

export function isRentChargeType(name: string): boolean {
  return /rent/i.test(name) && !/deposit|fee|insurance/i.test(name);
}

interface UnitOccupancy {
  tenants: Tenant[];
  moveIn: string | null;
  moveOut: string | null;
  futureOnly: boolean;
}

/**
 * Maps units to their current occupants. Current leases are the primary
 * source; Tenant.UnitID covers tenants without a lease record.
 */
export function buildOccupancy(
  tenants: Tenant[],
  leases: Lease[],
  today: string
): { byUnit: Map<number, UnitOccupancy>; unlinked: Tenant[] } {
  const tenantById = new Map(tenants.map((t) => [t.TenantID, t]));
  const byUnit = new Map<number, UnitOccupancy>();
  const linked = new Set<number>();

  const add = (unitId: number, tenant: Tenant, moveIn: string | null, moveOut: string | null) => {
    const entry = byUnit.get(unitId) ?? { tenants: [], moveIn: null, moveOut: null, futureOnly: true };
    if (!entry.tenants.some((t) => t.TenantID === tenant.TenantID)) entry.tenants.push(tenant);
    if (moveIn && (!entry.moveIn || moveIn < entry.moveIn)) entry.moveIn = moveIn;
    if (moveOut && (!entry.moveOut || moveOut > entry.moveOut)) entry.moveOut = moveOut;
    entry.futureOnly &&= Boolean(moveIn && moveIn > today);
    byUnit.set(unitId, entry);
    linked.add(tenant.TenantID);
  };

  for (const lease of leases) {
    const tenant = tenantById.get(lease.TenantID);
    if (!tenant || !lease.UnitID) continue;
    const moveOut = datePart(lease.MoveOutDate);
    if (moveOut && moveOut < today) continue;
    add(lease.UnitID, tenant, datePart(lease.MoveInDate), moveOut);
  }
  for (const tenant of tenants) {
    if (!linked.has(tenant.TenantID) && tenant.UnitID) add(tenant.UnitID, tenant, null, null);
  }

  return { byUnit, unlinked: tenants.filter((t) => !linked.has(t.TenantID)) };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function first<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

function isMissingRoute(err: unknown): boolean {
  return err instanceof RentManagerError && [400, 404, 405].includes(err.status);
}

class TtlCache<T> {
  private value: T | undefined;
  private expires = 0;
  constructor(private readonly ttlMs: number) {}
  async get(load: () => Promise<T>): Promise<T> {
    if (this.value !== undefined && Date.now() < this.expires) return this.value;
    this.value = await load();
    this.expires = Date.now() + this.ttlMs;
    return this.value;
  }
}

// ── Service ──

export interface TenantLabel {
  propertyName: string;
  unitName: string;
}

export interface PropertySummary {
  property: Property;
  units: number;
  occupied: number;
  notice: number;
  vacant: number;
  receivables: number;
  delinquentCount: number;
  delinquentAmount: number;
}

export class RentManagerService {
  private readonly properties = new TtlCache<Property[]>(5 * 60_000);
  private readonly chargeTypes = new TtlCache<Map<number, string>>(30 * 60_000);
  private readonly unitTypes = new TtlCache<Map<number, string>>(30 * 60_000);

  constructor(
    readonly client: RentManagerClient,
    readonly config: RentManagerConfig,
    private readonly now: () => Date = () => new Date()
  ) {}

  today(): string {
    return localDate(this.now());
  }

  // ── Properties & units ──

  async listProperties(includeInactive = false): Promise<Property[]> {
    const all = await this.properties.get(() => this.client.getAll<Property>("/Properties", { fields: PROPERTY_FIELDS }));
    const list = includeInactive ? all : all.filter((p) => p.IsActive !== false);
    return [...list].sort((a, b) => (a.Name ?? "").localeCompare(b.Name ?? ""));
  }

  async resolveProperty(input: string): Promise<Property> {
    const all = await this.listProperties(true);
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) {
      const byId = all.find((p) => p.PropertyID === Number(trimmed));
      if (byId) return byId;
    }

    const wanted = normalize(trimmed);
    const exact = all.filter((p) => normalize(p.Name) === wanted || (p.ShortName && normalize(p.ShortName) === wanted));
    if (exact.length === 1) return exact[0];

    const tokens = wanted.split(" ").filter(Boolean);
    const pool = exact.length
      ? exact
      : all.filter((p) => {
          const hay = normalize(`${p.Name} ${p.ShortName ?? ""}`);
          return tokens.every((tok) => hay.includes(tok));
        });
    if (pool.length === 1) return pool[0];
    const active = pool.filter((p) => p.IsActive !== false);
    if (active.length === 1) return active[0];

    const describe = (p: Property) => `- ${p.Name}${p.ShortName ? ` (${p.ShortName})` : ""}, ID ${p.PropertyID}${p.IsActive === false ? ", inactive" : ""}`;
    if (pool.length > 1) {
      throw new UserFacingError(
        `"${input}" matches ${pool.length} properties. Use the full name or the property ID:\n${pool.map(describe).join("\n")}`
      );
    }
    const suggestions = all.filter((p) => tokens.some((tok) => normalize(p.Name).includes(tok))).slice(0, 10);
    const fallback = suggestions.length ? suggestions : all.filter((p) => p.IsActive !== false).slice(0, 25);
    throw new UserFacingError(
      `No property matches "${input}". ${suggestions.length ? "Did you mean one of these?" : "Available properties:"}\n${fallback.map(describe).join("\n")}`
    );
  }

  async getUnits(propertyId: number, includeInactive = false): Promise<Unit[]> {
    let units: Unit[];
    try {
      units = await this.client.getAll<Unit>(`/Properties/${propertyId}/Units`, { fields: UNIT_FIELDS });
    } catch (err) {
      if (!isMissingRoute(err)) throw err;
      units = await this.client.getAll<Unit>("/Units", { filters: [rql.eq("PropertyID", propertyId)], fields: UNIT_FIELDS });
    }
    return includeInactive ? units : units.filter((u) => u.IsActive !== false);
  }

  private async getAllUnits(properties: Property[]): Promise<Unit[]> {
    try {
      return await this.client.getAll<Unit>("/Units", { fields: UNIT_FIELDS });
    } catch (err) {
      if (!isMissingRoute(err)) throw err;
      const perProperty = await mapLimit(properties, CONCURRENCY, (p) => this.getUnits(p.PropertyID, true));
      return perProperty.flat();
    }
  }

  async resolveUnit(property: Property, input: string): Promise<Unit> {
    const units = await this.getUnits(property.PropertyID, true);
    const matches = matchUnit(units, input);
    const active = matches.filter((u) => u.IsActive !== false);
    if (matches.length === 1) return matches[0];
    if (active.length === 1) return active[0];
    if (matches.length > 1) {
      throw new UserFacingError(
        `"${input}" matches ${matches.length} units at ${property.Name}: ${matches.map(unitLabel).join(", ")}. Be more specific.`
      );
    }
    throw new UserFacingError(`No unit "${input}" found at ${property.Name} (${units.length} units on file).`);
  }

  private async unitNameMap(unitIds: number[]): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    const ids = [...new Set(unitIds.filter((id) => Number.isInteger(id) && id > 0))];
    for (const ids100 of chunk(ids, 100)) {
      try {
        const units = await this.client.getAll<Unit>("/Units", { filters: [rql.in("UnitID", ids100)], fields: UNIT_FIELDS });
        for (const u of units) names.set(u.UnitID, unitLabel(u));
      } catch (err) {
        console.error(`[rent-manager] could not look up unit names: ${err instanceof Error ? err.message : err}`);
      }
    }
    return names;
  }

  async labelTenants(tenants: Tenant[]): Promise<Map<number, TenantLabel>> {
    const [properties, units] = await Promise.all([
      this.listProperties(true),
      this.unitNameMap(tenants.map((t) => t.UnitID ?? 0)),
    ]);
    const propertyNames = new Map(properties.map((p) => [p.PropertyID, p.Name]));
    return new Map(
      tenants.map((t) => [
        t.TenantID,
        {
          propertyName: (t.PropertyID && propertyNames.get(t.PropertyID)) || "-",
          unitName: (t.UnitID && units.get(t.UnitID)) || "-",
        },
      ])
    );
  }

  // ── Tenants ──

  /** Searches tenants by name, email or display ID across several fields, then filters locally so every word must match. */
  async searchTenants(
    query: string,
    opts: { propertyId?: number; activeOnly?: boolean } = {}
  ): Promise<Tenant[]> {
    const raw = query.trim();
    const isEmail = raw.includes("@");
    const tokens = normalize(rqlValue(raw)).split(" ").filter(Boolean);
    if (!tokens.length) throw new UserFacingError("Provide a tenant name, email, or tenant ID to search for.");

    const base: string[] = [];
    if (opts.propertyId) base.push(rql.eq("PropertyID", opts.propertyId));
    if (opts.activeOnly) base.push(rql.eq("IsActive", true));

    const clauses = new Set<string>();
    if (isEmail) {
      clauses.add(rql.ct("Email", raw));
    } else {
      const cleaned = rqlValue(raw);
      clauses.add(rql.ct("Name", cleaned));
      // One-letter fragments (the "o" in O'Brien) would match most of the tenant
      // list, so only longer words become server-side filters. Every word is
      // still required by the local filter below.
      const words = tokens.filter((tok) => tok.length > 1);
      if (words.length) {
        clauses.add(rql.ct("LastName", words[words.length - 1]));
        clauses.add(rql.ct("FirstName", words[0]));
        if (words.length > 1) clauses.add(rql.ct("LastName", words[0]));
      }
      if (/^\d+$/.test(cleaned)) {
        clauses.add(rql.eq("TenantID", cleaned));
        clauses.add(rql.eq("TenantDisplayID", cleaned));
      }
    }

    const found = new Map<number, Tenant>();
    const errors: unknown[] = [];
    await Promise.all(
      [...clauses].map(async (clause) => {
        try {
          const rows = await this.client.getAll<Tenant>("/Tenants", { filters: [...base, clause], fields: TENANT_FIELDS }, 5);
          for (const t of rows) found.set(t.TenantID, t);
        } catch (err) {
          errors.push(err);
        }
      })
    );
    if (errors.length === clauses.size) throw errors[0];

    const results = [...found.values()].filter((t) => {
      if (isEmail) return String(t.Email ?? "").toLowerCase().includes(raw.toLowerCase());
      const hay = normalize([t.Name, t.FirstName, t.LastName, t.TenantDisplayID, t.TenantID].join(" "));
      return tokens.every((tok) => hay.includes(tok));
    });

    const wanted = tokens.join(" ");
    const isExact = (t: Tenant) =>
      normalize(t.Name) === wanted ||
      normalize(`${t.FirstName ?? ""} ${t.LastName ?? ""}`) === wanted ||
      normalize(`${t.LastName ?? ""} ${t.FirstName ?? ""}`) === wanted;
    return results.sort(
      (a, b) =>
        Number(isExact(b)) - Number(isExact(a)) ||
        Number(b.IsActive !== false) - Number(a.IsActive !== false) ||
        tenantName(a).localeCompare(tenantName(b))
    );
  }

  async getTenant(tenantId: number): Promise<Tenant> {
    try {
      const tenant = first(await this.client.get<Tenant | Tenant[]>(`/Tenants/${tenantId}`, { fields: TENANT_FIELDS }));
      if (tenant?.TenantID) return tenant;
    } catch (err) {
      if (!(err instanceof RentManagerError && err.status === 404)) throw err;
    }
    throw new UserFacingError(`No tenant with ID ${tenantId}.`);
  }

  private async currentTenantsInUnit(unit: Unit): Promise<Tenant[]> {
    const direct = await this.client
      .getAll<Tenant>("/Tenants", { filters: [rql.eq("UnitID", unit.UnitID), rql.eq("IsActive", true)], fields: TENANT_FIELDS })
      .catch((err) => {
        if (isMissingRoute(err)) return [] as Tenant[];
        throw err;
      });
    if (direct.length) return direct;

    const leases = await this.client
      .getAll<Lease>("/Leases", { filters: [rql.eq("UnitID", unit.UnitID)], fields: LEASE_FIELDS })
      .catch(() => [] as Lease[]);
    const today = this.today();
    const ids = [
      ...new Set(leases.filter((l) => !datePart(l.MoveOutDate) || datePart(l.MoveOutDate)! >= today).map((l) => l.TenantID)),
    ];
    if (!ids.length) return [];
    const tenants = await this.client.getAll<Tenant>("/Tenants", { filters: [rql.in("TenantID", ids)], fields: TENANT_FIELDS });
    return tenants.filter((t) => t.IsActive !== false);
  }

  async describeTenants(tenants: Tenant[]): Promise<string> {
    const labels = await this.labelTenants(tenants);
    return tenants
      .map((t) => {
        const l = labels.get(t.TenantID);
        return `- ${tenantName(t)} (tenant ID ${t.TenantID}) | ${l?.unitName ?? "-"} at ${l?.propertyName ?? "-"} | ${t.IsActive === false ? "past" : "current"}`;
      })
      .join("\n");
  }

  /**
   * Resolves exactly one tenant from an ID, a name, or a property + unit.
   * Never guesses: several matches raise an error listing them, unless exactly
   * one has the full name typed.
   */
  async resolveTenant(args: {
    tenantId?: number;
    tenantName?: string;
    propertyName?: string;
    unitName?: string;
  }): Promise<Tenant> {
    if (args.tenantId) return this.getTenant(args.tenantId);

    const property = args.propertyName ? await this.resolveProperty(args.propertyName) : undefined;
    let candidates: Tenant[];
    let where = "";

    if (property && args.unitName) {
      const unit = await this.resolveUnit(property, args.unitName);
      where = ` in ${unitLabel(unit)} at ${property.Name}`;
      candidates = await this.currentTenantsInUnit(unit);
      if (args.tenantName) {
        const tokens = normalize(args.tenantName).split(" ").filter(Boolean);
        candidates = candidates.filter((t) => tokens.every((tok) => normalize(tenantName(t)).includes(tok)));
      }
      if (!candidates.length) {
        throw new UserFacingError(`No current tenant found${where}${args.tenantName ? ` named "${args.tenantName}"` : ""}. The unit may be vacant.`);
      }
    } else if (args.tenantName) {
      where = property ? ` at ${property.Name}` : "";
      candidates = await this.searchTenants(args.tenantName, { propertyId: property?.PropertyID });
      if (!candidates.length) throw new UserFacingError(`No tenant matches "${args.tenantName}"${where}.`);
    } else {
      throw new UserFacingError("Identify the tenant with tenant_id, tenant_name, or property_name + unit_name.");
    }

    if (candidates.length === 1) return candidates[0];

    if (args.tenantName) {
      const wanted = normalize(args.tenantName);
      const exact = candidates.filter(
        (t) => normalize(tenantName(t)) === wanted || normalize(`${t.FirstName ?? ""} ${t.LastName ?? ""}`) === wanted
      );
      if (exact.length === 1) return exact[0];
    }

    const shown = candidates.slice(0, 15);
    throw new UserFacingError(
      `${candidates.length} tenants match${where}. Re-run with tenant_id set to one of these:\n${await this.describeTenants(shown)}` +
        (candidates.length > shown.length ? `\n…and ${candidates.length - shown.length} more. Narrow the search.` : "")
    );
  }

  // ── Ledger, balances, notes ──

  async getTransactions(tenantId: number): Promise<Transaction[]> {
    return this.client.getAll<Transaction>(`/Tenants/${tenantId}/Transactions`);
  }

  async chargeTypeNames(): Promise<Map<number, string>> {
    return this.chargeTypes.get(async () => {
      const types = await this.client.getAll<ChargeType>("/ChargeTypes").catch(() => [] as ChargeType[]);
      return new Map(types.map((c) => [c.ChargeTypeID, c.Name || c.Description || `Charge type ${c.ChargeTypeID}`]));
    });
  }

  async getNotes(tenantId: number): Promise<HistoryItem[]> {
    const items = await this.client.getAll<HistoryItem>(`/Tenants/${tenantId}/History`, {}, 5);
    const when = (h: HistoryItem) => h.HistoryDate ?? h.CreateDate ?? "";
    return items.sort((a, b) => when(b).localeCompare(when(a)));
  }

  /**
   * Adds a history note. The documented pattern for child history is
   * POST /{Entity}/{id}/History; some instances expose tenant notes under
   * /Tenants/HistoryNotes instead. The second route is only tried when the
   * first does not exist (404/405), which means nothing was written.
   */
  async addNote(tenantId: number, note: string, categoryId?: number): Promise<{ endpoint: string; historyId?: number }> {
    const entry: Record<string, unknown> = { Note: note, HistoryDate: localDateTime(this.now()) };
    const category = categoryId ?? this.config.noteCategoryId;
    if (category) entry.HistoryCategoryID = category;

    const attempts: Array<{ path: string; body: unknown }> = [
      { path: `/Tenants/${tenantId}/History`, body: entry },
      { path: "/Tenants/HistoryNotes", body: [{ ...entry, ParentID: tenantId }] },
    ];
    for (const [i, attempt] of attempts.entries()) {
      try {
        const saved = first(await this.client.post<HistoryItem | HistoryItem[] | null>(attempt.path, attempt.body));
        return { endpoint: attempt.path, historyId: saved?.HistoryID };
      } catch (err) {
        const last = i === attempts.length - 1;
        if (!last && err instanceof RentManagerError && (err.status === 404 || err.status === 405)) continue;
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  // ── Delinquency ──

  async getDelinquencies(opts: {
    propertyId?: number;
    minBalance: number;
    includeAging: boolean;
    includePastTenants: boolean;
  }): Promise<{ records: DelinquencyRecord[]; agingSkipped: number }> {
    const filters: string[] = [];
    if (opts.propertyId) filters.push(rql.eq("PropertyID", opts.propertyId));
    if (!opts.includePastTenants) filters.push(rql.eq("IsActive", true));
    const tenants = await this.client.getAll<Tenant>("/Tenants", { filters, fields: TENANT_FIELDS });

    if (tenants.length && tenants.every((t) => t.CurrentBalance === undefined)) {
      throw new UserFacingError(
        "Rent Manager returned tenants without a CurrentBalance field, so balances can't be read on this instance. " +
          "Use rm_api_get on Tenants to see which balance fields your version returns."
      );
    }

    const delinquent = tenants
      .filter((t) => (t.CurrentBalance ?? 0) >= opts.minBalance)
      .sort((a, b) => (b.CurrentBalance ?? 0) - (a.CurrentBalance ?? 0));
    const labels = await this.labelTenants(delinquent);
    const today = this.today();

    const toAge = opts.includeAging ? delinquent.slice(0, MAX_AGING_LOOKUPS) : [];
    const aging = await mapLimit(toAge, CONCURRENCY, async (t) => {
      try {
        return computeAging(await this.getTransactions(t.TenantID), today);
      } catch (err) {
        console.error(`[rent-manager] aging lookup failed for tenant ${t.TenantID}: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    });

    const records = delinquent.map((t, i) => ({
      tenant: t,
      tenantName: tenantName(t),
      propertyName: labels.get(t.TenantID)?.propertyName ?? "-",
      unitName: labels.get(t.TenantID)?.unitName ?? "-",
      balance: t.CurrentBalance ?? 0,
      aging: aging[i] ?? null,
    }));
    return { records, agingSkipped: opts.includeAging ? Math.max(0, delinquent.length - MAX_AGING_LOOKUPS) : 0 };
  }

  // ── Rent roll & occupancy ──

  private async getLeases(propertyId?: number): Promise<Lease[]> {
    const filters = propertyId ? [rql.eq("PropertyID", propertyId)] : [];
    try {
      return await this.client.getAll<Lease>("/Leases", { filters, fields: LEASE_FIELDS });
    } catch (err) {
      console.error(`[rent-manager] leases unavailable, using Tenant.UnitID only: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async unitTypeNames(): Promise<Map<number, string>> {
    return this.unitTypes.get(async () => {
      const types = await this.client.getAll<UnitType>("/UnitTypes").catch(() => [] as UnitType[]);
      return new Map(types.map((t) => [t.UnitTypeID, t.Name]));
    });
  }

  async getRentRoll(property: Property, includeCharges: boolean): Promise<RentRoll & { unlinked: Tenant[] }> {
    const today = this.today();
    const [units, tenants, leases] = await Promise.all([
      this.getUnits(property.PropertyID),
      this.client.getAll<Tenant>("/Tenants", {
        filters: [rql.eq("PropertyID", property.PropertyID), rql.eq("IsActive", true)],
        fields: TENANT_FIELDS,
      }),
      this.getLeases(property.PropertyID),
    ]);
    const unitIds = new Set(units.map((u) => u.UnitID));
    const { byUnit, unlinked } = buildOccupancy(tenants, leases, today);
    const unitTypes = units.some((u) => u.UnitTypeID) ? await this.unitTypeNames() : new Map<number, string>();

    const occupantIds = [...byUnit.entries()].filter(([id]) => unitIds.has(id)).flatMap(([, o]) => o.tenants.map((t) => t.TenantID));
    let chargesIncluded = false;
    const chargesByTenant = new Map<number, RecurringCharge[]>();
    let chargeNames = new Map<number, string>();
    if (includeCharges && occupantIds.length) {
      chargeNames = await this.chargeTypeNames();
      const lists = await mapLimit(occupantIds, CONCURRENCY, (id) =>
        this.client.getAll<RecurringCharge>(`/Tenants/${id}/RecurringCharges`).catch(() => null)
      );
      lists.forEach((list, i) => list && chargesByTenant.set(occupantIds[i], list));
      chargesIncluded = chargesByTenant.size > 0;
    }

    const chargeTotals: Record<string, number> = {};
    const rows: RentRollRow[] = units.map((unit) => {
      const occ = byUnit.get(unit.UnitID);
      const occupants = occ?.tenants ?? [];
      const chargesByType: Record<string, number> = {};
      let rent = 0;
      let otherRecurring = 0;
      for (const t of occupants) {
        for (const charge of chargesByTenant.get(t.TenantID) ?? []) {
          if (!isChargeActive(charge, today)) continue;
          const name = (charge.ChargeTypeID && chargeNames.get(charge.ChargeTypeID)) || "Other";
          const monthly = round2(monthlyAmount(charge));
          chargesByType[name] = round2((chargesByType[name] ?? 0) + monthly);
          if (isRentChargeType(name)) rent += monthly;
          else otherRecurring += monthly;
        }
      }
      const status: RentRollRow["status"] = !occupants.length
        ? "Vacant"
        : occ?.futureOnly
          ? "Pending Move-In"
          : occ?.moveOut
            ? "Notice"
            : "Occupied";
      // Totals describe in-place income, so a lot awaiting move-in doesn't count yet.
      if (status === "Occupied" || status === "Notice") {
        for (const [name, monthly] of Object.entries(chargesByType)) {
          chargeTotals[name] = round2((chargeTotals[name] ?? 0) + monthly);
        }
      }
      return {
        unit,
        unitName: unitLabel(unit),
        unitType: (unit.UnitTypeID && unitTypes.get(unit.UnitTypeID)) || null,
        status,
        tenants: occupants,
        tenantNames: occupants.map(tenantName).join("; "),
        moveInDate: occ?.moveIn ?? null,
        moveOutDate: occ?.moveOut ?? null,
        rent: round2(rent),
        otherRecurring: round2(otherRecurring),
        chargesByType,
        balance: round2(occupants.reduce((sum, t) => sum + (t.CurrentBalance ?? 0), 0)),
      };
    });

    rows.sort((a, b) => a.unitName.localeCompare(b.unitName, undefined, { numeric: true, sensitivity: "base" }));
    return { property, rows, chargeTotals, chargesIncluded, unlinked: unlinked.filter((t) => !t.UnitID || !unitIds.has(t.UnitID)) };
  }

  async getPortfolioSummary(propertyIds?: number[]): Promise<PropertySummary[]> {
    const today = this.today();
    let properties = await this.listProperties(false);
    if (propertyIds?.length) properties = (await this.listProperties(true)).filter((p) => propertyIds.includes(p.PropertyID));
    const wanted = new Set(properties.map((p) => p.PropertyID));

    const [allUnits, tenants] = await Promise.all([
      propertyIds?.length === 1 ? this.getUnits(propertyIds[0], true) : this.getAllUnits(properties),
      this.client.getAll<Tenant>("/Tenants", {
        filters: [rql.eq("IsActive", true), ...(propertyIds?.length === 1 ? [rql.eq("PropertyID", propertyIds[0])] : [])],
        fields: TENANT_FIELDS,
      }),
    ]);
    const units = allUnits.filter((u) => u.IsActive !== false && wanted.has(u.PropertyID));
    // Leases carry the move-in/move-out dates that separate notice and pending move-ins from occupied.
    const leases = await this.getLeases(propertyIds?.length === 1 ? propertyIds[0] : undefined);
    const { byUnit } = buildOccupancy(tenants, leases, today);
    const unitProperty = new Map(units.map((u) => [u.UnitID, u.PropertyID]));

    return properties.map((property) => {
      const propUnits = units.filter((u) => u.PropertyID === property.PropertyID);
      let occupied = 0;
      let notice = 0;
      for (const u of propUnits) {
        const occ = byUnit.get(u.UnitID);
        if (!occ?.tenants.length || occ.futureOnly) continue;
        occupied++;
        if (occ.moveOut) notice++;
      }
      const propTenants = tenants.filter(
        (t) => (t.PropertyID ?? (t.UnitID ? unitProperty.get(t.UnitID) : undefined)) === property.PropertyID
      );
      const owing = propTenants.filter((t) => (t.CurrentBalance ?? 0) > 0);
      return {
        property,
        units: propUnits.length,
        occupied,
        notice,
        vacant: propUnits.length - occupied,
        receivables: round2(propTenants.reduce((s, t) => s + (t.CurrentBalance ?? 0), 0)),
        delinquentCount: owing.length,
        delinquentAmount: round2(owing.reduce((s, t) => s + (t.CurrentBalance ?? 0), 0)),
      };
    });
  }

  // ── Work orders (Service Manager) ──

  async getWorkOrders(opts: { propertyId?: number; includeClosed: boolean }): Promise<ServiceManagerIssue[]> {
    const filters: string[] = [];
    if (!opts.includeClosed) filters.push(rql.eq("IsClosed", false));
    if (opts.propertyId) filters.push(rql.eq("PropertyID", opts.propertyId));
    const issues = await this.client.getAll<ServiceManagerIssue>(
      "/ServiceManagerIssues",
      { filters, embed: ["Status", "Category", "Priority", "Unit"] },
      10
    );
    return issues.sort((a, b) => String(b.CreateDate ?? "").localeCompare(String(a.CreateDate ?? "")));
  }

  async createWorkOrder(input: {
    title: string;
    description: string;
    propertyId: number;
    unitId?: number;
    tenantId?: number;
    categoryId?: number;
    priorityId?: number;
    statusId?: number;
  }): Promise<ServiceManagerIssue | undefined> {
    const payload: Record<string, unknown> = {
      Title: input.title,
      Description: input.description,
      IsClosed: false,
      PropertyID: input.propertyId,
    };
    if (input.unitId) payload.UnitID = input.unitId;
    if (input.tenantId) payload.TenantID = input.tenantId;
    if (input.categoryId) payload.CategoryID = input.categoryId;
    if (input.priorityId) payload.PriorityID = input.priorityId;
    if (input.statusId) payload.StatusID = input.statusId;
    return first(await this.client.post<ServiceManagerIssue | ServiceManagerIssue[] | null>("/ServiceManagerIssues", payload));
  }
}
