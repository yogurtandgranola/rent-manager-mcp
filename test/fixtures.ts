import type { Handler, MockRequest, MockResponse } from "./helpers.js";

// A small manufactured housing community, shaped like a live Rent Manager 12
// instance: tenants carry Status (no IsActive, UnitID, Email or balance),
// lots come from Leases, emails from Contacts, balances from open Charges and
// Payments, and next month's charges are already posted. "Today" is
// 2026-10-26 in the tests.

export const properties = [
  { PropertyID: 1, Name: "Sunflower Estates", ShortName: "SUN", IsActive: true },
  { PropertyID: 2, Name: "Oak Park", ShortName: "OAKP", IsActive: true },
  { PropertyID: 3, Name: "Oak Ridge", ShortName: "OAKR", IsActive: true },
  { PropertyID: 4, Name: "Old Mill", ShortName: "MILL", IsActive: false },
];

export const units = [
  { UnitID: 101, PropertyID: 1, Name: "SA-1", UnitTypeID: 9 },
  { UnitID: 102, PropertyID: 1, Name: "SA-2", UnitTypeID: 9 },
  { UnitID: 103, PropertyID: 1, Name: "SA-3", UnitTypeID: 10 },
  { UnitID: 110, PropertyID: 1, Name: "SA-10", UnitTypeID: 9 },
  { UnitID: 201, PropertyID: 2, Name: "7" },
];

export const unitTypes = [
  { UnitTypeID: 9, Name: "Lot" },
  { UnitTypeID: 10, Name: "Park Owned Home" },
];

export const tenants = [
  { TenantID: 1, Name: "Alice Smith", FirstName: "Alice", LastName: "Smith", PropertyID: 1, Status: "Current" },
  { TenantID: 2, Name: "Bob Jones", FirstName: "Bob", LastName: "Jones", PropertyID: 1, Status: "Current" },
  { TenantID: 3, Name: "Carol Smith", FirstName: "Carol", LastName: "Smith", PropertyID: 1, Status: "Future" },
  { TenantID: 4, Name: "John Smith", FirstName: "John", LastName: "Smith", PropertyID: 1, Status: "Past" },
  { TenantID: 5, Name: "John Smithson", FirstName: "John", LastName: "Smithson", PropertyID: 2, Status: "Current" },
];

export const contacts = [
  { ContactID: 11, ParentID: 1, ParentType: "Tenant", Email: "alice@example.com" },
  { ContactID: 15, ParentID: 5, ParentType: "Tenant", Email: "jsmithson@example.com" },
];

export const leases = [
  { LeaseID: 1, TenantID: 1, UnitID: 101, PropertyID: 1, MoveInDate: "2021-04-01T00:00:00", MoveOutDate: null },
  { LeaseID: 2, TenantID: 2, UnitID: 102, PropertyID: 1, MoveInDate: "2019-06-15T00:00:00", MoveOutDate: "2026-11-30T00:00:00" },
  { LeaseID: 3, TenantID: 3, UnitID: 110, PropertyID: 1, MoveInDate: "2026-11-01T00:00:00", MoveOutDate: null },
  { LeaseID: 4, TenantID: 4, UnitID: 103, PropertyID: 1, MoveInDate: "2018-01-01T00:00:00", MoveOutDate: "2025-12-31T00:00:00" },
  { LeaseID: 5, TenantID: 5, UnitID: 201, PropertyID: 2, MoveInDate: "2024-02-01T00:00:00", MoveOutDate: null },
];

// Names are codes; the description is the readable label.
export const chargeTypes = [
  { ChargeTypeID: 1, Name: "LOT", Description: "Lot Rent" },
  { ChargeTypeID: 2, Name: "H2O", Description: "Water Utility" },
  { ChargeTypeID: 3, Name: "LC", Description: "Late Charge" },
  { ChargeTypeID: 4, Name: "POH", Description: "Park Owned Home Monthly Rent" },
];

export const recurringCharges = [
  { RecurringChargeID: 11, EntityType: "Tenant", EntityKeyID: 1, UnitID: 101, ChargeTypeID: 1, Amount: 500, Frequency: 1 },
  { RecurringChargeID: 12, EntityType: "Tenant", EntityKeyID: 1, UnitID: 101, ChargeTypeID: 2, Amount: 40, Frequency: 1 },
  { RecurringChargeID: 13, EntityType: "Tenant", EntityKeyID: 1, UnitID: 101, ChargeTypeID: 1, Amount: 450, Frequency: 1, ToDate: "2025-12-31T00:00:00" },
  { RecurringChargeID: 21, EntityType: "Tenant", EntityKeyID: 2, UnitID: 102, ChargeTypeID: 1, Amount: 525, Frequency: 1 },
  { RecurringChargeID: 22, EntityType: "Tenant", EntityKeyID: 2, UnitID: 102, ChargeTypeID: 4, Amount: 225, Frequency: 1, FromDate: "2025-04-01T00:00:00" },
  { RecurringChargeID: 31, EntityType: "Tenant", EntityKeyID: 3, UnitID: 110, ChargeTypeID: 1, Amount: 510, Frequency: 1 },
];

// Ledger rows as /Tenants/{id}/Transactions returns them: payments negative.
export const transactions: Record<number, unknown[]> = {
  1: [
    { ID: 1, TransactionDate: "2026-09-01T00:00:00", TransactionType: "Charge", Description: "Lot Rent", Amount: 500 },
    { ID: 2, TransactionDate: "2026-09-08T00:00:00", TransactionType: "Payment", Description: "Payment Received", Reference: "Check #: 1042", Amount: -590 },
    { ID: 3, TransactionDate: "2026-10-01T00:00:00", TransactionType: "Charge", Description: "Lot Rent", Amount: 500 },
    { ID: 4, TransactionDate: "2026-10-01T00:00:00", TransactionType: "Charge", Description: "Water Utility", Amount: 40 },
    { ID: 5, TransactionDate: "2026-11-01T00:00:00", TransactionType: "Charge", Description: "Lot Rent", Amount: 500 },
  ],
  4: [{ ID: 9, TransactionDate: "2025-11-01T00:00:00", TransactionType: "Charge", Description: "Lot Rent", Amount: 1200 }],
  5: [{ ID: 10, TransactionDate: "2026-10-01T00:00:00", TransactionType: "Charge", Description: "Lot Rent", Amount: 75 }],
};

// Charges with their allocation state; IsFullyAllocated=false ones are what's still owed.
export const charges = [
  { ChargeID: 101, AccountID: 1, PropertyID: 1, Amount: 500, AmountAllocated: 500, IsFullyAllocated: true, TransactionDate: "2026-09-01T00:00:00", ChargeTypeID: 1 },
  { ChargeID: 102, AccountID: 1, PropertyID: 1, Amount: 500, AmountAllocated: 90, IsFullyAllocated: false, TransactionDate: "2026-10-01T00:00:00", ChargeTypeID: 1 },
  { ChargeID: 103, AccountID: 1, PropertyID: 1, Amount: 40, AmountAllocated: 0, IsFullyAllocated: false, TransactionDate: "2026-10-01T00:00:00", ChargeTypeID: 2 },
  // Posted early for November: not due yet.
  { ChargeID: 104, AccountID: 1, PropertyID: 1, Amount: 500, AmountAllocated: 0, IsFullyAllocated: false, TransactionDate: "2026-11-01T00:00:00", ChargeTypeID: 1 },
  { ChargeID: 105, AccountID: 2, PropertyID: 1, Amount: 750, AmountAllocated: 0, IsFullyAllocated: false, TransactionDate: "2026-11-01T00:00:00", ChargeTypeID: 1 },
  { ChargeID: 401, AccountID: 4, PropertyID: 1, Amount: 1200, AmountAllocated: 0, IsFullyAllocated: false, TransactionDate: "2025-11-01T00:00:00", ChargeTypeID: 1 },
  { ChargeID: 501, AccountID: 5, PropertyID: 2, Amount: 75, AmountAllocated: 0, IsFullyAllocated: false, TransactionDate: "2026-10-01T00:00:00", ChargeTypeID: 1 },
];

export const payments = [
  { PaymentID: 1, AccountID: 1, Amount: 590, AmountAllocated: 590, IsFullyAllocated: true, TransactionDate: "2026-09-08T00:00:00", ReversalDate: null },
  { PaymentID: 2, AccountID: 1, Amount: 300, AmountAllocated: 300, IsFullyAllocated: true, TransactionDate: "2026-08-03T00:00:00", ReversalDate: null },
  // Bounced check: reversed payments don't count as the last payment.
  { PaymentID: 3, AccountID: 1, Amount: 500, AmountAllocated: 0, IsFullyAllocated: true, TransactionDate: "2026-10-05T00:00:00", ReversalDate: "2026-10-09T00:00:00" },
  // Carol paid a deposit before moving in: unapplied credit.
  { PaymentID: 4, AccountID: 3, Amount: 25, AmountAllocated: 0, IsFullyAllocated: false, TransactionDate: "2026-10-20T00:00:00", ReversalDate: null },
];

export const issues = [
  { ServiceManagerIssueID: 5, Title: "Well house valve leak", IsClosed: false, StatusID: 3, PriorityID: 5, CategoryID: 4, CreateDate: "2026-10-01T09:00:00" },
  { ServiceManagerIssueID: 6, Title: "Pothole on Oak Lane", IsClosed: false, StatusID: 2, PriorityID: 4, CategoryID: 4, CreateDate: "2026-10-20T09:00:00" },
  { ServiceManagerIssueID: 7, Title: "Old closed job", IsClosed: true, StatusID: 5, PriorityID: 5, CategoryID: 4, CreateDate: "2026-01-01T09:00:00" },
];
export const issueProperties: Record<number, number> = { 5: 1, 6: 2, 7: 1 };

const lookups: Record<string, unknown[]> = {
  "/ServiceManagerStatuses": [
    { ServiceManagerStatusID: 2, Name: "New" },
    { ServiceManagerStatusID: 3, Name: "Work In Progress" },
    { ServiceManagerStatusID: 5, Name: "Resolved" },
  ],
  "/ServiceManagerPriorities": [
    { ServiceManagerPriorityID: 4, Name: "High" },
    { ServiceManagerPriorityID: 5, Name: "Low" },
  ],
  "/ServiceManagerCategories": [{ ServiceManagerCategoryID: 4, Name: "Maintenance" }],
};

// Filter fields each endpoint accepts. Anything else gets the 400 (or, for
// RecurringCharges, the 500) the live API returns.
const FILTERABLE: Record<string, string[]> = {
  "/Tenants": ["TenantID", "TenantDisplayID", "Name", "FirstName", "LastName", "PropertyID", "Status", "Leases.UnitID"],
  "/Units": ["UnitID", "PropertyID", "Name"],
  "/Leases": ["LeaseID", "TenantID", "UnitID", "PropertyID"],
  "/Charges": ["ChargeID", "AccountID", "PropertyID", "IsFullyAllocated"],
  "/Payments": ["PaymentID", "AccountID", "IsFullyAllocated"],
  "/RecurringCharges": ["RecurringChargeID", "EntityType", "EntityKeyID", "UnitID"],
  "/ServiceManagerIssues": ["ServiceManagerIssueID", "IsClosed", "Properties.PropertyID"],
  "/Contacts": ["ContactID", "ParentID", "ParentType", "Email"],
  "/ChargeTypes": ["ChargeTypeID"],
};

function clauses(filters: string | null): Array<[string, string, string]> {
  return (filters ?? "")
    .split(";")
    .filter(Boolean)
    .map((c) => {
      const [field, op, ...rest] = c.split(",");
      return [field, op, rest.join(",")];
    });
}

function matches(row: Record<string, unknown>, [field, op, value]: [string, string, string]): boolean {
  let actual: unknown = row[field];
  if (field === "Leases.UnitID") actual = leases.filter((l) => l.TenantID === row.TenantID).map((l) => l.UnitID);
  if (field === "Properties.PropertyID") actual = [issueProperties[row.ServiceManagerIssueID as number]];
  const values = Array.isArray(actual) ? actual.map(String) : [String(actual)];
  if (op === "eq") return values.includes(value);
  if (op === "ne") return !values.includes(value);
  if (op === "ct") return values.some((v) => v.toLowerCase().includes(value.toLowerCase()));
  if (op === "in") {
    const wanted = value.replace(/[()]/g, "").split(",");
    return values.some((v) => wanted.includes(v));
  }
  return true;
}

/** Lists like the live API: filtered, paged, and null (not []) when nothing matches. */
function list(req: MockRequest, path: string, rows: Array<Record<string, unknown>>): MockResponse {
  const allowed = FILTERABLE[path];
  for (const clause of clauses(req.query.get("filters"))) {
    if (allowed && !allowed.includes(clause[0])) {
      return path === "/RecurringCharges"
        ? { status: 500, body: { UserMessage: "Unspecified Error", DeveloperMessage: `Unable to locate target property ${clause[0]}` } }
        : { status: 400, body: { Message: "The request is invalid." } };
    }
  }
  if (Number(req.query.get("pagenumber") ?? 1) > 1) return { body: null };
  const out = rows.filter((row) => clauses(req.query.get("filters")).every((c) => matches(row, c)));
  return { body: out.length ? out : null };
}

/** Routes the fixture data like the live instance does. */
export const fixtureApi: Handler = (req) => {
  if (req.method !== "GET") return undefined;
  const page = Number(req.query.get("pagenumber") ?? 1);

  const child = /^\/(Tenants|Properties|ServiceManagerIssues)\/(\d+)\/(\w+)$/.exec(req.path);
  if (child) {
    const id = Number(child[2]);
    if (child[1] === "Properties" && child[3] === "Units") return list(req, "/Units", units.filter((u) => u.PropertyID === id));
    if (child[3] === "Transactions") return { body: page > 1 ? null : (transactions[id] ?? null) };
    if (child[3] === "RecurringCharges") return list(req, "/RecurringCharges", recurringCharges.filter((r) => r.EntityKeyID === id));
    if (child[3] === "History") return { body: null };
  }
  const single = /^\/Tenants\/(\d+)$/.exec(req.path);
  if (single) {
    const t = tenants.find((x) => x.TenantID === Number(single[1]));
    return t ? { body: t } : { status: 404, body: { UserMessage: "Not found" } };
  }

  const tables: Record<string, Array<Record<string, unknown>>> = {
    "/Properties": properties,
    "/Units": units,
    "/UnitTypes": unitTypes,
    "/Tenants": tenants,
    "/Contacts": contacts,
    "/Leases": leases,
    "/ChargeTypes": chargeTypes,
    "/RecurringCharges": recurringCharges,
    "/Charges": charges,
    "/Payments": payments,
    "/ServiceManagerIssues": issues,
  };
  if (tables[req.path]) return list(req, req.path, tables[req.path]);
  if (lookups[req.path]) return { body: page > 1 ? null : lookups[req.path] };
  return undefined;
};
