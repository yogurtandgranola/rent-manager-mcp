import type {
  RentManagerConfig,
  Tenant,
  Property,
  ChargeItem,
  DelinquencyRecord,
  RentRollEntry,
  TenantNote,
  ApiError,
} from "./types.js";

export class RentManagerClient {
  private config: RentManagerConfig;
  private authToken: string | null = null;
  private propertyCache: Property[] | null = null;

  constructor(config: RentManagerConfig) {
    this.config = config;
  }

  // The RM12 API expects the token in the X-RM12Api-ApiToken header for ALL
  // requests — both static tokens and tokens obtained via AuthorizeUser.
  // (It does NOT use Authorization: Bearer.)
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    let token = this.config.apiToken;
    if (!token && this.config.username && this.config.password) {
      if (!this.authToken) {
        this.authToken = await this.authenticate();
      }
      token = this.authToken;
    }

    if (token) {
      headers["X-RM12Api-ApiToken"] = token;
    }

    return headers;
  }

  private async authenticate(): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/Authentication/AuthorizeUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Username: this.config.username,
        Password: this.config.password,
        ...(this.config.locationId ? { LocationID: Number(this.config.locationId) } : {}),
      }),
    });

    if (!res.ok) {
      throw this.buildError(res.status, "Authentication failed — check your username, password, and location ID", "/Authentication/AuthorizeUser");
    }

    // AuthorizeUser returns the APIToken directly as a JSON string
    // (e.g. "ABC123..."), not wrapped in an object. Handle both shapes
    // defensively in case of proxy/version differences.
    const data = await res.json();
    const token =
      typeof data === "string" ? data : data?.ApiToken || data?.Token || data?.token;
    if (!token) {
      throw this.buildError(500, "AuthorizeUser succeeded but no token was found in the response", "/Authentication/AuthorizeUser");
    }
    return token;
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
      res = await fetch(url, options);
    } catch (err) {
      throw this.buildError(0, `Network error connecting to Rent Manager API: ${err}`, path);
    }

    if (res.status === 401 && this.config.username && this.config.password) {
      // Token may have expired — re-authenticate once and retry
      this.authToken = null;
      this.authToken = await this.authenticate();
      const retryHeaders = await this.getAuthHeaders();
      res = await fetch(url, { ...options, headers: retryHeaders });
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw this.buildError(
        res.status,
        `Rent Manager API error: ${res.statusText}${errorBody ? ` — ${errorBody}` : ""}`,
        path
      );
    }

    return res.json() as Promise<T>;
  }

  // ── Response Normalization ──
  //
  // RM12 returns embedded records as nested objects/arrays (e.g. a tenant's
  // units arrive as an embedded `Units` array), not as flat fields. These
  // helpers accept several plausible shapes so the tools keep working across
  // schema variations instead of silently rendering "undefined".

  private num(v: unknown): number {
    const n = typeof v === "string" ? parseFloat(v) : (v as number);
    return typeof n === "number" && !Number.isNaN(n) ? n : 0;
  }

  private normalizeTenant(raw: any, propertyNameById: Map<number, string>): Tenant {
    const unit = raw.Units?.[0] ?? raw.Unit ?? null;
    const propertyId: number = raw.PropertyID ?? unit?.PropertyID ?? 0;
    const balance =
      raw.Balance ?? raw.Balances?.[0]?.Balance ?? raw.OpenBalance ?? 0;

    // RM tenants have a display Name plus optional FirstName/LastName
    let firstName: string = raw.FirstName ?? "";
    let lastName: string = raw.LastName ?? "";
    if (!firstName && !lastName && typeof raw.Name === "string") {
      const parts = raw.Name.trim().split(/\s+/);
      firstName = parts[0] ?? "";
      lastName = parts.slice(1).join(" ");
    }

    return {
      TenantID: raw.TenantID,
      FirstName: firstName,
      LastName: lastName,
      Email: raw.Email ?? "",
      Phone: raw.Phone ?? "",
      MoveInDate: raw.MoveInDate ?? raw.PostingStartDate ?? "",
      MoveOutDate: raw.MoveOutDate ?? null,
      UnitID: raw.UnitID ?? unit?.UnitID ?? 0,
      UnitName: raw.UnitName ?? unit?.Name ?? "",
      PropertyID: propertyId,
      PropertyName:
        raw.PropertyName ?? raw.Property?.Name ?? propertyNameById.get(propertyId) ?? "",
      Balance: this.num(balance),
    };
  }

  private async getPropertyNameMap(): Promise<Map<number, string>> {
    const properties = await this.getProperties();
    return new Map(properties.map((p) => [p.PropertyID, p.Name]));
  }

  // ── Core API Methods ──

  async getProperties(): Promise<Property[]> {
    if (!this.propertyCache) {
      this.propertyCache = await this.request<Property[]>("GET", "/Properties");
    }
    return this.propertyCache;
  }

  async findPropertyByName(name: string): Promise<Property | null> {
    const properties = await this.getProperties();
    const lower = name.toLowerCase();
    return (
      properties.find((p) => p.Name.toLowerCase() === lower) ??
      properties.find((p) => p.Name.toLowerCase().includes(lower)) ??
      null
    );
  }

  private async getTenantsForProperty(propertyId?: number): Promise<Tenant[]> {
    // Tenants carry PropertyID directly, so filter on it rather than
    // traversing Unit.PropertyID. Balance/Units arrive as embeds.
    let path = "/Tenants?embeds=Balance,Units";
    if (propertyId) {
      path += `&filters=PropertyID,eq,${propertyId}`;
    }
    const raw = await this.request<any[]>("GET", path);
    const nameMap = await this.getPropertyNameMap();
    return raw.map((t) => this.normalizeTenant(t, nameMap));
  }

  async getDelinquencies(propertyId?: number): Promise<DelinquencyRecord[]> {
    // RM12 has no simple GET /Reports/Delinquency endpoint (reports run
    // through the report-writer API), so delinquency is derived from
    // tenant balances — the same data the RM delinquency report rolls up.
    const tenants = await this.getTenantsForProperty(propertyId);
    return tenants
      .filter((t) => t.Balance > 0 && !t.MoveOutDate)
      .map((t) => ({
        TenantID: t.TenantID,
        TenantName: `${t.FirstName} ${t.LastName}`.trim(),
        UnitName: t.UnitName || "Unknown",
        PropertyName: t.PropertyName || "Unknown",
        Balance: t.Balance,
        DaysPastDue: 0, // Not derivable from balances alone; needs charge aging
        LastPaymentDate: null,
        LastPaymentAmount: null,
      }))
      .sort((a, b) => b.Balance - a.Balance);
  }

  async getTenantLedger(tenantId: number): Promise<ChargeItem[]> {
    // Financial activity lives under Transactions. (/Tenants/{id}/History is
    // RM's notes system, not the ledger.)
    let raw: any[];
    try {
      raw = await this.request<any[]>("GET", `/Tenants/${tenantId}/Transactions`);
    } catch {
      raw = await this.request<any[]>("GET", `/Tenants/${tenantId}/Ledger`);
    }

    return raw.map((item) => ({
      ChargeID: item.TransactionID ?? item.ChargeID ?? 0,
      TenantID: item.TenantID ?? tenantId,
      Date: item.TransactionDate ?? item.Date ?? item.CreateDate ?? "",
      Description: item.Comment ?? item.Description ?? item.Memo ?? "",
      Amount: this.num(item.Amount ?? item.TransactionAmount),
      Balance: this.num(item.Balance ?? item.RunningBalance),
      Type: item.TransactionType ?? item.Type ?? "",
    }));
  }

  async findTenantByName(name: string): Promise<Tenant[]> {
    // RM12 filters use an RQL subset: `co` is the contains operator.
    const parts = name.trim().split(/\s+/);
    let filters = "";
    if (parts.length >= 2) {
      filters = `filters=FirstName,co,${encodeURIComponent(parts[0])};LastName,co,${encodeURIComponent(parts.slice(1).join(" "))}`;
    } else {
      filters = `filters=LastName,co,${encodeURIComponent(parts[0])}`;
    }
    const raw = await this.request<any[]>("GET", `/Tenants?${filters}&embeds=Balance,Units`);
    const nameMap = await this.getPropertyNameMap();
    let tenants = raw.map((t) => this.normalizeTenant(t, nameMap));

    // Fall back to a full-name contains match when first+last yields nothing
    // (covers tenants stored with a single Name field or reversed order).
    if (tenants.length === 0 && parts.length >= 2) {
      const rawByName = await this.request<any[]>(
        "GET",
        `/Tenants?filters=Name,co,${encodeURIComponent(name.trim())}&embeds=Balance,Units`
      );
      tenants = rawByName.map((t) => this.normalizeTenant(t, nameMap));
    }
    return tenants;
  }

  async findTenantByUnit(propertyName: string, unitName: string): Promise<Tenant[]> {
    const property = await this.findPropertyByName(propertyName);
    if (!property) {
      throw this.buildError(404, `Property "${propertyName}" not found`, "/Properties");
    }
    const tenants = await this.getTenantsForProperty(property.PropertyID);
    const lower = unitName.toLowerCase();
    return tenants.filter((t) => t.UnitName.toLowerCase().includes(lower));
  }

  async addTenantNote(tenantId: number, noteContent: string): Promise<TenantNote> {
    // Tenant notes are History records in RM12.
    const raw = await this.request<any>("POST", `/Tenants/${tenantId}/History`, {
      HistoryDate: new Date().toISOString(),
      Comment: noteContent,
    });
    return {
      NoteID: raw.HistoryID ?? raw.NoteID ?? 0,
      TenantID: raw.TenantID ?? tenantId,
      Date: raw.HistoryDate ?? raw.Date ?? new Date().toISOString(),
      Content: raw.Comment ?? raw.Content ?? noteContent,
      CreatedBy: raw.CreateUserID?.toString() ?? raw.CreatedBy ?? "",
    };
  }

  async getRentRoll(propertyId: number): Promise<RentRollEntry[]> {
    // Built by joining /Units with /Tenants — RM12 exposes no simple
    // GET /Reports/RentRoll endpoint.
    const [units, tenants] = await Promise.all([
      this.request<any[]>("GET", `/Units?filters=PropertyID,eq,${propertyId}`),
      this.getTenantsForProperty(propertyId),
    ]);

    const tenantByUnitId = new Map<number, Tenant>();
    for (const t of tenants) {
      if (t.UnitID && !t.MoveOutDate) {
        tenantByUnitId.set(t.UnitID, t);
      }
    }

    return units.map((u) => {
      const tenant = tenantByUnitId.get(u.UnitID) ?? null;
      return {
        UnitID: u.UnitID,
        UnitName: u.Name ?? u.UnitName ?? String(u.UnitID),
        TenantID: tenant?.TenantID ?? null,
        TenantName: tenant ? `${tenant.FirstName} ${tenant.LastName}`.trim() : null,
        MoveInDate: tenant?.MoveInDate ?? null,
        LeaseEnd: null, // Requires the Leases embed; not exposed in this join
        MonthlyRent: this.num(u.CurrentRent ?? u.MarketRent),
        Balance: tenant?.Balance ?? 0,
        Status: tenant ? "Occupied" : "Vacant",
      };
    });
  }
}
