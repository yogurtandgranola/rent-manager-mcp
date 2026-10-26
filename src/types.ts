// Rent Manager 12 (WAPI12) models.
//
// Field names follow what the public Rent Manager SDKs have observed in live
// responses. Rent Manager instances differ by version and configuration, so
// every field beyond the primary key is optional and the code reading these
// records must tolerate missing values.

export interface RentManagerConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  /** A pre-issued token. Used as-is; we can only re-authenticate if username/password are also set. */
  apiToken?: string;
  locationId: number;
  readOnly: boolean;
  timeoutMs: number;
  /** Default HistoryCategoryID applied to new tenant notes when the caller does not pass one. */
  noteCategoryId?: number;
}

export interface Property {
  PropertyID: number;
  Name: string;
  ShortName?: string;
  IsActive?: boolean;
}

export interface Unit {
  UnitID: number;
  PropertyID: number;
  Name?: string;
  UnitNumber?: string;
  UnitTypeID?: number;
  IsActive?: boolean;
}

export interface UnitType {
  UnitTypeID: number;
  Name: string;
}

export interface Tenant {
  TenantID: number;
  TenantDisplayID?: number | string;
  Name?: string;
  FirstName?: string;
  LastName?: string;
  Email?: string;
  PropertyID?: number;
  UnitID?: number;
  IsActive?: boolean;
  CurrentBalance?: number;
  /** "Current", "Past" or "Future" on instances without IsActive. */
  Status?: string;
}

export interface Lease {
  LeaseID: number;
  TenantID: number;
  UnitID: number;
  PropertyID?: number;
  MoveInDate?: string | null;
  MoveOutDate?: string | null;
}

export interface Transaction {
  TransactionID?: number;
  ID?: number;
  TenantID?: number;
  Amount: number;
  TransactionDate: string;
  TransactionType?: string;
  Type?: string;
  /** Charge type or payment label, e.g. "Lot Rent", "Payment Received". */
  Description?: string;
  Comment?: string;
  Reference?: string;
  ChargeTypeID?: number;
}

export interface HistoryItem {
  HistoryID: number;
  HistoryDate?: string;
  HistoryType?: string;
  HistoryTypeString?: string;
  HistoryCategoryID?: number;
  Note?: string;
  NoteText?: string;
  CreateDate?: string;
}

export interface ChargeType {
  ChargeTypeID: number;
  Name: string;
  Description?: string;
}

export interface RecurringCharge {
  RecurringChargeID: number;
  TenantID?: number;
  EntityType?: string;
  EntityKeyID?: number;
  UnitID?: number;
  ChargeTypeID?: number;
  Amount: number;
  Frequency?: string | number;
  FrequencyType?: string;
  FromDate?: string | null;
  ToDate?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
}

export interface NamedLookup {
  Name?: string;
}

export interface ServiceManagerIssue {
  ServiceManagerIssueID: number;
  Title?: string;
  Description?: string;
  IsClosed?: boolean;
  PropertyID?: number;
  UnitID?: number;
  TenantID?: number;
  StatusID?: number;
  CategoryID?: number;
  PriorityID?: number;
  CreateDate?: string;
  DueDate?: string;
  Status?: NamedLookup;
  Category?: NamedLookup;
  Priority?: NamedLookup;
  Unit?: Unit;
}

/** An unpaid (or partly paid) charge: what the tenant still owes on it is Amount - AmountAllocated. */
export interface OpenCharge {
  ChargeID: number;
  AccountID: number;
  Amount: number;
  AmountAllocated?: number;
  TransactionDate: string;
  ChargeTypeID?: number;
  UnitID?: number;
}

/** A payment not yet fully applied to charges: the remainder is a credit on the account. */
export interface OpenPayment {
  PaymentID: number;
  AccountID: number;
  Amount: number;
  AmountAllocated?: number;
  TransactionDate: string;
  ReversalDate?: string | null;
}

export interface LookupRow {
  Name?: string;
  [key: string]: unknown;
}

// ── Derived shapes produced by the service layer ──

export interface AgingBuckets {
  current: number; // 0-30 days
  days31to60: number;
  days61to90: number;
  over90: number;
}

export interface AgingResult {
  /** What the tenant owes as of today: open charges dated today or earlier, less unapplied credits. */
  balance?: number;
  buckets: AgingBuckets;
  oldestUnpaidDate: string | null;
  daysPastDue: number;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
}

export interface DelinquencyRecord {
  tenant: Tenant;
  tenantName: string;
  propertyName: string;
  unitName: string;
  balance: number;
  aging: AgingResult | null;
}

export interface RentRollRow {
  unit: Unit;
  unitName: string;
  unitType: string | null;
  status: "Occupied" | "Vacant" | "Notice" | "Pending Move-In";
  tenants: Tenant[];
  tenantNames: string;
  moveInDate: string | null;
  moveOutDate: string | null;
  rent: number;
  otherRecurring: number;
  chargesByType: Record<string, number>;
  balance: number;
}

export interface RentRoll {
  property: Property;
  rows: RentRollRow[];
  chargeTotals: Record<string, number>;
  chargesIncluded: boolean;
}
