export interface RentManagerConfig {
  baseUrl: string;
  apiToken?: string;
  username?: string;
  password?: string;
  locationId: string;
}

export interface Tenant {
  TenantID: number;
  FirstName: string;
  LastName: string;
  Name?: string;
  Email: string;
  Phone: string;
  Status?: string;
  MoveInDate: string;
  MoveOutDate: string | null;
  UnitID: number;
  UnitName: string;
  PropertyID: number;
  PropertyName: string;
  Balance: number;
  LeaseStart?: string | null;
  LeaseEnd?: string | null;
}

export interface Property {
  PropertyID: number;
  Name: string;
  Address: string;
  City: string;
  State: string;
  Zip: string;
  UnitCount: number;
}

export interface Unit {
  UnitID: number;
  Name: string;
  PropertyID: number;
  PropertyName: string;
  TenantID: number | null;
  TenantName: string | null;
  MarketRent: number;
  CurrentRent: number;
  Status: string;
  MoveInDate?: string;
  LeaseEnd?: string;
  Balance?: number;
  LastMoveOutDate?: string | null;
}

export interface ChargeItem {
  ChargeID: number;
  TenantID: number;
  Date: string;
  Description: string;
  Amount: number;
  Balance: number;
  Type: string; // "Charge" | "Payment" | "Credit"
}

export interface DelinquencyRecord {
  TenantID: number;
  TenantName: string;
  UnitName: string;
  PropertyName: string;
  Balance: number;
  DaysPastDue: number;
  LastPaymentDate: string | null;
  LastPaymentAmount: number | null;
}

export interface RentRollEntry {
  UnitID: number;
  UnitName: string;
  TenantID: number | null;
  TenantName: string | null;
  MoveInDate: string | null;
  LeaseEnd: string | null;
  MonthlyRent: number;
  Balance: number;
  Status: string; // "Occupied" | "Vacant" | "Notice"
}

export interface VacantUnit {
  UnitID: number;
  UnitName: string;
  PropertyName: string;
  MarketRent: number;
  LastMoveOutDate: string | null;
  DaysVacant: number | null;
}

export interface ExpiringLease {
  TenantID: number;
  TenantName: string;
  UnitName: string;
  PropertyName: string;
  LeaseEnd: string;
  DaysUntilExpiration: number;
  MonthlyRent: number | null;
}

export interface WorkOrder {
  WorkOrderID: number;
  Title: string;
  Description: string;
  Status: string;
  Priority: string | null;
  PropertyName: string | null;
  UnitName: string | null;
  TenantName: string | null;
  CreatedDate: string | null;
  ScheduledDate: string | null;
  IsClosed: boolean;
}

export interface TenantNote {
  NoteID: number;
  TenantID: number;
  Date: string;
  Content: string;
  CreatedBy: string;
}

export interface PropertySummary {
  PropertyID: number;
  PropertyName: string;
  TotalUnits: number;
  OccupiedUnits: number;
  VacantUnits: number;
  OccupancyRate: number; // 0–100
  ScheduledMonthlyRent: number;
  DelinquentTenants: number;
  DelinquentBalance: number;
}

/** Everything a dashboard render needs, gathered in one pass. */
export interface PortfolioSnapshot {
  generatedAt: string;
  properties: PropertySummary[];
  delinquencies: DelinquencyRecord[];
  expiringLeases: ExpiringLease[];
  vacantUnits: VacantUnit[];
}

// ── Reports engine ──

export interface ReportDefinition {
  ReportID: number;
  Name: string;
  Description?: string;
  ReportGroup?: string;
  Group?: string;
  Category?: string;
}

/** Report parameter metadata varies by RM version — keep it loose. */
export type ReportParameterDef = Record<string, unknown>;

export type ReportFormat = "data" | "pdf" | "excel";

export type ReportParamValue = string | number | boolean | Array<string | number>;

// ── Financials & other entities (loosely typed — RM field names vary) ──

export interface GLAccount {
  GLAccountID: number;
  Name: string;
  AccountNumber?: string;
  Number?: string;
  GLAccountType?: string;
  Type?: string;
  Description?: string;
  IsActive?: boolean;
}

export type LooseRecord = Record<string, unknown>;

export interface ApiError {
  status: number;
  message: string;
  endpoint: string;
}
