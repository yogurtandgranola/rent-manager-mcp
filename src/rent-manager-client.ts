import type {
  RentManagerConfig,
  Tenant,
  Property,
  ChargeItem,
  DelinquencyRecord,
  RentRollEntry,
  VacantUnit,
  ExpiringLease,
  WorkOrder,
  TenantNote,
  PropertySummary,
  PortfolioSnapshot,
  ApiError,
  Unit,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const PROPERTY_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 500;
const MAX_PAGES = 40;

/** Pull a value out of a loosely-typed API record, trying several field names. */
function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

function tenantDisplayName(t: Tenant): string {
  const joined = [t.FirstName, t.LastName].filter(Boolean).join(" ").trim();
  return joined || t.Name || `Tenant #${t.TenantID}`;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

export class RentManagerClient {
  private config: RentManagerConfig;
  private authToken: string | null = null;
  private propertyCache: { data: Property[]; fetchedAt: number } | null = null;

  constructor(config: RentManagerConfig) {
    this.config = config;
  }

  // ── Auth & transport ──

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.config.apiToken) {
      headers["X-RM12Api-ApiToken"] = this.config.apiToken;
    } else if (this.config.username && this.config.password) {
      if (!this.authToken) {
        this.authToken = await this.authenticate();
      }
      // Rent Manager's API expects the session token from AuthorizeUser in the
      // same X-RM12Api-ApiToken header, not a Bearer Authorization header.
      headers["X-RM12Api-ApiToken"] = this.authToken;
    }

    return headers;
  }

  private async authenticate(): Promise<string> {
    const res = await this.fetchWithTimeout(`${this.config.baseUrl}/Authentication/AuthorizeUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Username: this.config.username,
        Password: this.config.password,
        LocationID: this.config.locationId,
      }),
    });

    if (!res.ok) {
      throw this.buildError(
        res.status,
        "Authentication failed — check RM_USERNAME, RM_PASSWORD, and RM_LOCATION_ID",
        "/Authentication/AuthorizeUser"
      );
    }

    // AuthorizeUser returns the token either as a bare JSON string or wrapped
    // in an object, depending on API version.
    const data = await res.json();
    if (typeof data === "string") return data.replace(/^"|"$/g, "");
    return data.Token || data.token || data.ApiToken;
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private buildError(status: number, message: string, endpoint: string): ApiError {
    return { status, message, endpoint };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const headers = await this.getAuthHeaders();

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, options);
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : `Network error connecting to Rent Manager API: ${err}`;
      throw this.buildError(0, reason, path);
    }

    if (res.status === 401 && this.config.username && this.config.password) {
      // Session token may have expired — re-authenticate once and retry
      this.authToken = await this.authenticate();
      const retryHeaders = await this.getAuthHeaders();
      res = await this.fetchWithTimeout(url, { ...options, headers: retryHeaders });
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      let hint = "";
      if (res.status === 401) hint = " (credentials rejected — check your API token or username/password)";
      if (res.status === 403) hint = " (your Rent Manager user may lack API permission for this resource)";
      if (res.status === 404) hint = " (endpoint not found — check RM_API_BASE_URL includes the full API path)";
      throw this.buildError(
        res.status,
        `Rent Manager API error: ${res.statusText}${hint}${errorBody ? ` — ${errorBody.slice(0, 300)}` : ""}`,
        path
      );
    }

    return res.json() as Promise<T>;
  }

  /**
   * Fetch every page of a list endpoint. Rent Manager caps list responses, so
   * large portfolios need PageSize/PageNumber paging. Stops when a page comes
   * back short, empty, or the safety cap is hit.
   */
  private async requestAllPages<T>(path: string): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const all: T[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.request<T[]>(
        "GET",
        `${path}${sep}PageSize=${PAGE_SIZE}&PageNumber=${page}`
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    return all;
  }

  // ── Properties ──

  async getProperties(): Promise<Property[]> {
    const now = Date.now();
    if (this.propertyCache && now - this.propertyCache.fetchedAt < PROPERTY_CACHE_TTL_MS) {
      return this.propertyCache.data;
    }
    const data = await this.requestAllPages<Property>("/Properties");
    this.propertyCache = { data, fetchedAt: now };
    return data;
  }

  async findPropertyByName(name: string): Promise<Property | null> {
    const properties = await this.getProperties();
    const lower = name.toLowerCase();
    // Prefer an exact match, then fall back to partial
    return (
      properties.find((p) => p.Name.toLowerCase() === lower) ??
      properties.find((p) => p.Name.toLowerCase().includes(lower)) ??
      null
    );
  }

  // ── Delinquencies ──

  async getDelinquencies(propertyId?: number): Promise<DelinquencyRecord[]> {
    let path = "/Reports/Delinquency";
    const params = new URLSearchParams();
    if (propertyId) {
      params.set("PropertyID", propertyId.toString());
    }
    params.set("LocationID", this.config.locationId);

    const query = params.toString();
    if (query) path += `?${query}`;

    try {
      return await this.request<DelinquencyRecord[]>("GET", path);
    } catch {
      // Fallback: build delinquency from tenants with positive balances
      return this.buildDelinquencyFromTenants(propertyId);
    }
  }

  private async buildDelinquencyFromTenants(propertyId?: number): Promise<DelinquencyRecord[]> {
    let path = "/Tenants?embeds=Unit,Property,Balance";
    if (propertyId) {
      path += `&filters=Unit.PropertyID,eq,${propertyId}`;
    }

    const tenants = await this.requestAllPages<Tenant>(path);
    return tenants
      .filter((t) => t.Balance > 0)
      .map((t) => ({
        TenantID: t.TenantID,
        TenantName: tenantDisplayName(t),
        UnitName: t.UnitName || "Unknown",
        PropertyName: t.PropertyName || "Unknown",
        Balance: t.Balance,
        DaysPastDue: 0, // Would need charge dates to calculate
        LastPaymentDate: null,
        LastPaymentAmount: null,
      }))
      .sort((a, b) => b.Balance - a.Balance);
  }

  // ── Tenants ──

  async getTenantLedger(tenantId: number): Promise<ChargeItem[]> {
    return this.request<ChargeItem[]>("GET", `/Tenants/${tenantId}/History`);
  }

  async findTenantByName(name: string): Promise<Tenant[]> {
    const parts = name.trim().split(/\s+/);
    let filters = "";
    if (parts.length >= 2) {
      filters = `filters=FirstName,cn,${parts[0]};LastName,cn,${parts.slice(1).join(" ")}`;
    } else {
      filters = `filters=LastName,cn,${parts[0]}`;
    }
    return this.request<Tenant[]>("GET", `/Tenants?${filters}&embeds=Unit,Property`);
  }

  async findTenantByUnit(propertyName: string, unitName: string): Promise<Tenant[]> {
    const property = await this.findPropertyByName(propertyName);
    if (!property) {
      throw this.buildError(404, `Property "${propertyName}" not found`, "/Properties");
    }
    return this.request<Tenant[]>(
      "GET",
      `/Tenants?filters=Unit.PropertyID,eq,${property.PropertyID};Unit.Name,cn,${unitName}&embeds=Unit,Property`
    );
  }

  async searchTenants(query: {
    name?: string;
    email?: string;
    phone?: string;
    status?: string;
    propertyName?: string;
  }): Promise<Tenant[]> {
    const filters: string[] = [];

    if (query.name) {
      // Match against either first or last name via a broad last-name search,
      // then filter client-side so "smi" matches John Smith and Smitha Rao.
      filters.push(`LastName,cn,${query.name.trim().split(/\s+/).pop()}`);
    }
    if (query.email) filters.push(`Email,cn,${query.email}`);
    if (query.phone) filters.push(`Phone,cn,${query.phone.replace(/\D/g, "")}`);
    if (query.status) filters.push(`Status,eq,${query.status}`);

    if (query.propertyName) {
      const property = await this.findPropertyByName(query.propertyName);
      if (!property) {
        throw this.buildError(404, `Property "${query.propertyName}" not found`, "/Properties");
      }
      filters.push(`Unit.PropertyID,eq,${property.PropertyID}`);
    }

    const filterParam = filters.length ? `filters=${filters.join(";")}&` : "";
    let tenants = await this.requestAllPages<Tenant>(`/Tenants?${filterParam}embeds=Unit,Property`);

    if (query.name) {
      const lower = query.name.toLowerCase();
      const nameMatched = tenants.filter((t) =>
        `${t.FirstName ?? ""} ${t.LastName ?? ""} ${t.Name ?? ""}`.toLowerCase().includes(lower)
      );
      // Keep the server-side result set if the client-side narrowing was too strict
      if (nameMatched.length > 0) tenants = nameMatched;
    }

    return tenants;
  }

  async getTenantBalance(tenantId: number): Promise<number> {
    const tenant = await this.request<Tenant>("GET", `/Tenants/${tenantId}?embeds=Balance`);
    return tenant.Balance ?? 0;
  }

  async addTenantNote(tenantId: number, noteContent: string): Promise<TenantNote> {
    return this.request<TenantNote>("POST", `/Tenants/${tenantId}/Notes`, {
      Content: noteContent,
      Date: new Date().toISOString(),
    });
  }

  // ── Rent roll & occupancy ──

  async getRentRoll(propertyId: number): Promise<RentRollEntry[]> {
    const path = `/Reports/RentRoll?PropertyID=${propertyId}&LocationID=${this.config.locationId}`;

    try {
      return await this.request<RentRollEntry[]>("GET", path);
    } catch {
      // Fallback: build rent roll from units
      return this.buildRentRollFromUnits(propertyId);
    }
  }

  private async buildRentRollFromUnits(propertyId: number): Promise<RentRollEntry[]> {
    const units = await this.requestAllPages<Unit>(
      `/Units?filters=PropertyID,eq,${propertyId}&embeds=Tenant`
    );

    return units.map((u) => ({
      UnitID: u.UnitID,
      UnitName: u.Name,
      TenantID: u.TenantID,
      TenantName: u.TenantName,
      MoveInDate: u.MoveInDate ?? null,
      LeaseEnd: u.LeaseEnd ?? null,
      MonthlyRent: u.CurrentRent || u.MarketRent,
      Balance: u.Balance ?? 0,
      Status: u.TenantID ? "Occupied" : "Vacant",
    }));
  }

  async getVacantUnits(propertyId?: number): Promise<VacantUnit[]> {
    let path = "/Units?embeds=Property";
    if (propertyId) {
      path += `&filters=PropertyID,eq,${propertyId}`;
    }

    const units = await this.requestAllPages<Record<string, unknown>>(path);
    const today = new Date();

    return units
      .filter((u) => !pick<number>(u, "TenantID", "CurrentTenantID"))
      .map((u) => {
        const moveOut = pick<string>(u, "LastMoveOutDate", "MoveOutDate") ?? null;
        return {
          UnitID: pick<number>(u, "UnitID") ?? 0,
          UnitName: pick<string>(u, "Name", "UnitName") ?? "Unknown",
          PropertyName: pick<string>(u, "PropertyName") ?? "Unknown",
          MarketRent: pick<number>(u, "MarketRent", "CurrentRent") ?? 0,
          LastMoveOutDate: moveOut,
          DaysVacant: moveOut ? Math.max(0, daysBetween(new Date(moveOut), today)) : null,
        };
      })
      .sort((a, b) => (b.DaysVacant ?? -1) - (a.DaysVacant ?? -1));
  }

  async getExpiringLeases(withinDays: number, propertyId?: number): Promise<ExpiringLease[]> {
    let path = "/Tenants?embeds=Unit,Property,Leases";
    if (propertyId) {
      path += `&filters=Unit.PropertyID,eq,${propertyId}`;
    }

    const tenants = await this.requestAllPages<Record<string, unknown>>(path);
    const today = new Date();
    const results: ExpiringLease[] = [];

    for (const t of tenants) {
      // Lease end may live on the tenant directly or on an embedded lease record
      let leaseEnd = pick<string>(t, "LeaseEnd", "LeaseEndDate");
      const leases = pick<Array<Record<string, unknown>>>(t, "Leases");
      if (!leaseEnd && Array.isArray(leases) && leases.length > 0) {
        const ends = leases
          .map((l) => pick<string>(l, "EndDate", "LeaseEnd"))
          .filter((d): d is string => Boolean(d))
          .sort();
        leaseEnd = ends[ends.length - 1];
      }
      if (!leaseEnd) continue;

      const days = daysBetween(today, new Date(leaseEnd));
      if (days < 0 || days > withinDays) continue;

      results.push({
        TenantID: pick<number>(t, "TenantID") ?? 0,
        TenantName:
          [pick<string>(t, "FirstName"), pick<string>(t, "LastName")].filter(Boolean).join(" ") ||
          pick<string>(t, "Name") ||
          "Unknown",
        UnitName: pick<string>(t, "UnitName") ?? "Unknown",
        PropertyName: pick<string>(t, "PropertyName") ?? "Unknown",
        LeaseEnd: leaseEnd,
        DaysUntilExpiration: days,
        MonthlyRent: pick<number>(t, "Rent", "MonthlyRent") ?? null,
      });
    }

    return results.sort((a, b) => a.DaysUntilExpiration - b.DaysUntilExpiration);
  }

  // ── Work orders (Service Manager) ──

  async getWorkOrders(propertyId?: number, includeClosed = false): Promise<WorkOrder[]> {
    const filters: string[] = [];
    if (propertyId) filters.push(`PropertyID,eq,${propertyId}`);
    if (!includeClosed) filters.push(`IsClosed,eq,false`);
    const filterParam = filters.length ? `filters=${filters.join(";")}&` : "";

    const issues = await this.requestAllPages<Record<string, unknown>>(
      `/ServiceManagerIssues?${filterParam}embeds=Property,Unit,Tenant,ServiceManagerPriority,ServiceManagerStatus`
    );

    return issues.map((i) => this.mapWorkOrder(i));
  }

  private mapWorkOrder(i: Record<string, unknown>): WorkOrder {
    const status = pick<Record<string, unknown>>(i, "ServiceManagerStatus");
    const priority = pick<Record<string, unknown>>(i, "ServiceManagerPriority");
    return {
      WorkOrderID: pick<number>(i, "ServiceManagerIssueID", "WorkOrderID", "IssueID") ?? 0,
      Title: pick<string>(i, "Title", "Subject") ?? "(no title)",
      Description: pick<string>(i, "Description", "Details") ?? "",
      Status:
        (status && pick<string>(status, "Name")) || pick<string>(i, "Status", "StatusName") || "Unknown",
      Priority:
        (priority && pick<string>(priority, "Name")) || pick<string>(i, "Priority", "PriorityName") || null,
      PropertyName: pick<string>(i, "PropertyName") ?? null,
      UnitName: pick<string>(i, "UnitName") ?? null,
      TenantName: pick<string>(i, "TenantName") ?? null,
      CreatedDate: pick<string>(i, "CreateDate", "CreatedDate", "OpenDate") ?? null,
      ScheduledDate: pick<string>(i, "ScheduledDate", "DueDate") ?? null,
      IsClosed: pick<boolean>(i, "IsClosed") ?? false,
    };
  }

  async createWorkOrder(input: {
    title: string;
    description: string;
    propertyId?: number;
    unitId?: number;
    tenantId?: number;
  }): Promise<WorkOrder> {
    const body: Record<string, unknown> = {
      Title: input.title,
      Description: input.description,
      OpenDate: new Date().toISOString(),
    };
    if (input.propertyId) body.PropertyID = input.propertyId;
    if (input.unitId) body.UnitID = input.unitId;
    if (input.tenantId) body.TenantID = input.tenantId;

    const created = await this.request<Record<string, unknown>>("POST", "/ServiceManagerIssues", body);
    return this.mapWorkOrder(created);
  }

  // ── Portfolio rollups (feeds summaries + dashboards) ──

  async getPropertySummaries(propertyId?: number): Promise<PropertySummary[]> {
    const properties = await this.getProperties();
    const targets = propertyId ? properties.filter((p) => p.PropertyID === propertyId) : properties;

    const summaries: PropertySummary[] = [];
    for (const property of targets) {
      const rentRoll = await this.getRentRoll(property.PropertyID);
      const occupied = rentRoll.filter((r) => r.Status === "Occupied").length;
      const delinquent = rentRoll.filter((r) => r.Balance > 0);

      summaries.push({
        PropertyID: property.PropertyID,
        PropertyName: property.Name,
        TotalUnits: rentRoll.length,
        OccupiedUnits: occupied,
        VacantUnits: rentRoll.length - occupied,
        OccupancyRate: rentRoll.length ? (occupied / rentRoll.length) * 100 : 0,
        ScheduledMonthlyRent: rentRoll.reduce(
          (sum, r) => sum + (r.Status === "Occupied" ? r.MonthlyRent : 0),
          0
        ),
        DelinquentTenants: delinquent.length,
        DelinquentBalance: delinquent.reduce((sum, r) => sum + r.Balance, 0),
      });
    }

    return summaries;
  }

  async getPortfolioSnapshot(propertyId?: number): Promise<PortfolioSnapshot> {
    const [properties, delinquencies, expiringLeases, vacantUnits] = await Promise.all([
      this.getPropertySummaries(propertyId),
      this.getDelinquencies(propertyId),
      this.getExpiringLeases(90, propertyId),
      this.getVacantUnits(propertyId),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      properties,
      delinquencies,
      expiringLeases,
      vacantUnits,
    };
  }
}
