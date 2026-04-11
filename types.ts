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
  Email: string;
  Phone: string;
  MoveInDate: string;
  MoveOutDate: string | null;
  UnitID: number;
  UnitName: string;
  PropertyID: number;
  PropertyName: string;
  Balance: number;
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

export interface TenantNote {
  NoteID: number;
  TenantID: number;
  Date: string;
  Content: string;
  CreatedBy: string;
}

export interface ApiError {
  status: number;
  message: string;
  endpoint: string;
}
