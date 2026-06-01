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

  constructor(config: RentManagerConfig) {
    this.config = config;
  }

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
      headers["Authorization"] = `Bearer ${this.authToken}`;
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
        LocationID: this.config.locationId,
      }),
    });

    if (!res.ok) {
      throw this.buildError(res.status, "Authentication failed — check your username, password, and location ID", "/Authentication/AuthorizeUser");
    }

    const data = await res.json();
    return data.Token || data.token;
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

    if (res.status === 401 && this.config.username) {
      // Token may have expired — re-authenticate once and retry
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

  // ── Core API Methods ──

  async getProperties(): Promise<Property[]> {
    return this.request<Property[]>("GET", "/Properties");
  }

  async findPropertyByName(name: string): Promise<Property | null> {
    const properties = await this.getProperties();
    const lower = name.toLowerCase();
    return (
      properties.find(
        (p) =>
          p.Name.toLowerCase().includes(lower) ||
          p.Name.toLowerCase() === lower
      ) ?? null
    );
  }

  async getDelinquencies(propertyId?: number): Promise<DelinquencyRecord[]> {
    // Rent Manager typically exposes delinquency through tenant balances
    // or a dedicated delinquency report endpoint
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
    let path = "/Tenants?embeds=Unit,Property";
    if (propertyId) {
      path += `&filters=Unit.PropertyID,eq,${propertyId}`;
    }

    const tenants = await this.request<Tenant[]>("GET", path);
    return tenants
      .filter((t) => t.Balance > 0)
      .map((t) => ({
        TenantID: t.TenantID,
        TenantName: `${t.FirstName} ${t.LastName}`,
        UnitName: t.UnitName || "Unknown",
        PropertyName: t.PropertyName || "Unknown",
        Balance: t.Balance,
        DaysPastDue: 0, // Would need charge dates to calculate
        LastPaymentDate: null,
        LastPaymentAmount: null,
      }))
      .sort((a, b) => b.Balance - a.Balance);
  }

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

  async addTenantNote(tenantId: number, noteContent: string): Promise<TenantNote> {
    return this.request<TenantNote>("POST", `/Tenants/${tenantId}/Notes`, {
      Content: noteContent,
      Date: new Date().toISOString(),
    });
  }

  async getRentRoll(propertyId: number): Promise<RentRollEntry[]> {
    let path = `/Reports/RentRoll?PropertyID=${propertyId}&LocationID=${this.config.locationId}`;

    try {
      return await this.request<RentRollEntry[]>("GET", path);
    } catch {
      // Fallback: build rent roll from units
      return this.buildRentRollFromUnits(propertyId);
    }
  }

  // ── Collections Rate ──
  //
  // Assumptions to validate against a real RM /Tenants/{id}/History response:
  //   - ChargeItem.Type is exactly "Charge" / "Payment" / "Credit" (per types.ts).
  //     If RM returns granular subtypes ("Rent Charge", "Tenant Payment", etc.),
  //     widen the comparisons below.
  //   - Ledger is pulled per currently-assigned tenant. Tenants who moved out
  //     mid-period are NOT included. Fine for a weekly pulse, not for tight accounting.
  //   - "Credit" entries are excluded from both billed and collected (treated as adjustments).
  //   - Date filter is a lex compare on ISO strings — works for "YYYY-MM-DD" and full ISO.
  //   - Payment amounts may be returned as negatives; Math.abs handles either sign.
  async getCollectionsRate(
    propertyId: number,
    startDate: string,
    endDate: string
  ): Promise<{
    PerTenant: Array<{
      TenantID: number;
      TenantName: string;
      UnitName: string;
      Billed: number;
      Collected: number;
      Rate: number;
    }>;
    TotalBilled: number;
    TotalCollected: number;
    Rate: number;
  }> {
    const tenants = await this.request<Tenant[]>(
      "GET",
      `/Tenants?filters=Unit.PropertyID,eq,${propertyId}&embeds=Unit,Property`
    );

    const perTenant = await Promise.all(
      tenants.map(async (t) => {
        const ledger = await this.getTenantLedger(t.TenantID);
        const inRange = ledger.filter(
          (item) => item.Date >= startDate && item.Date <= endDate
        );
        const billed = inRange
          .filter((item) => item.Type === "Charge")
          .reduce((sum, item) => sum + item.Amount, 0);
        const collected = inRange
          .filter((item) => item.Type === "Payment")
          .reduce((sum, item) => sum + Math.abs(item.Amount), 0);
        return {
          TenantID: t.TenantID,
          TenantName: `${t.FirstName} ${t.LastName}`,
          UnitName: t.UnitName || "Unknown",
          Billed: billed,
          Collected: collected,
          Rate: billed > 0 ? collected / billed : 0,
        };
      })
    );

    const withActivity = perTenant.filter((r) => r.Billed > 0 || r.Collected > 0);
    withActivity.sort((a, b) => a.Rate - b.Rate);

    const totalBilled = withActivity.reduce((s, r) => s + r.Billed, 0);
    const totalCollected = withActivity.reduce((s, r) => s + r.Collected, 0);

    return {
      PerTenant: withActivity,
      TotalBilled: totalBilled,
      TotalCollected: totalCollected,
      Rate: totalBilled > 0 ? totalCollected / totalBilled : 0,
    };
  }

  private async buildRentRollFromUnits(propertyId: number): Promise<RentRollEntry[]> {
    const units = await this.request<
      Array<{
        UnitID: number;
        Name: string;
        TenantID: number | null;
        TenantName: string | null;
        MarketRent: number;
        CurrentRent: number;
        Status: string;
        MoveInDate?: string;
        LeaseEnd?: string;
        Balance?: number;
      }>
    >("GET", `/Units?filters=PropertyID,eq,${propertyId}&embeds=Tenant`);

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
}
