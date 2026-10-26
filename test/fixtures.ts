import type { Handler } from "./helpers.js";

// A small manufactured housing community, as Rent Manager would return it.
export const properties = [
  { PropertyID: 1, Name: "Sunflower Estates", ShortName: "SUN", IsActive: true },
  { PropertyID: 2, Name: "Oak Park", ShortName: "OAKP", IsActive: true },
  { PropertyID: 3, Name: "Oak Ridge", ShortName: "OAKR", IsActive: true },
  { PropertyID: 4, Name: "Old Mill", ShortName: "MILL", IsActive: false },
];

export const units = [
  { UnitID: 101, PropertyID: 1, Name: "Lot 1", IsActive: true },
  { UnitID: 102, PropertyID: 1, Name: "Lot 2", IsActive: true },
  { UnitID: 103, PropertyID: 1, Name: "Lot 3", IsActive: true },
  { UnitID: 110, PropertyID: 1, Name: "Lot 10", IsActive: true },
  { UnitID: 199, PropertyID: 1, Name: "Lot 99", IsActive: false },
  { UnitID: 201, PropertyID: 2, Name: "7", IsActive: true },
];

export const tenants = [
  { TenantID: 1, Name: "Alice Smith", FirstName: "Alice", LastName: "Smith", PropertyID: 1, UnitID: 101, IsActive: true, CurrentBalance: 450 },
  { TenantID: 2, Name: "Bob Jones", FirstName: "Bob", LastName: "Jones", PropertyID: 1, UnitID: 102, IsActive: true, CurrentBalance: 0 },
  { TenantID: 3, Name: "Carol Smith", FirstName: "Carol", LastName: "Smith", PropertyID: 1, UnitID: 110, IsActive: true, CurrentBalance: -25 },
  { TenantID: 4, Name: "John Smith", FirstName: "John", LastName: "Smith", PropertyID: 1, UnitID: 103, IsActive: false, CurrentBalance: 1200 },
  { TenantID: 5, Name: "John Smithson", FirstName: "John", LastName: "Smithson", PropertyID: 2, UnitID: 201, IsActive: true, CurrentBalance: 75 },
];

export const leases = [
  { LeaseID: 1, TenantID: 1, UnitID: 101, PropertyID: 1, MoveInDate: "2021-04-01T00:00:00", MoveOutDate: null },
  { LeaseID: 2, TenantID: 2, UnitID: 102, PropertyID: 1, MoveInDate: "2019-06-15T00:00:00", MoveOutDate: "2026-11-30T00:00:00" },
  { LeaseID: 3, TenantID: 3, UnitID: 110, PropertyID: 1, MoveInDate: "2026-11-01T00:00:00", MoveOutDate: null },
  { LeaseID: 4, TenantID: 4, UnitID: 103, PropertyID: 1, MoveInDate: "2018-01-01T00:00:00", MoveOutDate: "2025-12-31T00:00:00" },
];

export const chargeTypes = [
  { ChargeTypeID: 1, Name: "Lot Rent" },
  { ChargeTypeID: 2, Name: "Water" },
  { ChargeTypeID: 3, Name: "Late Fee" },
];

export const recurringCharges: Record<number, unknown[]> = {
  1: [
    { RecurringChargeID: 11, TenantID: 1, ChargeTypeID: 1, Amount: 500 },
    { RecurringChargeID: 12, TenantID: 1, ChargeTypeID: 2, Amount: 40 },
    { RecurringChargeID: 13, TenantID: 1, ChargeTypeID: 1, Amount: 450, ToDate: "2025-12-31T00:00:00" },
  ],
  2: [{ RecurringChargeID: 21, TenantID: 2, ChargeTypeID: 1, Amount: 525 }],
  3: [{ RecurringChargeID: 31, TenantID: 3, ChargeTypeID: 1, Amount: 510 }],
};

export const transactions: Record<number, unknown[]> = {
  1: [
    { TransactionID: 1, TransactionDate: "2026-09-01T00:00:00", TransactionType: "Charge", Amount: 500, ChargeTypeID: 1 },
    { TransactionID: 2, TransactionDate: "2026-09-08T00:00:00", TransactionType: "Payment", Amount: 590, Comment: "Check 1042" },
    { TransactionID: 3, TransactionDate: "2026-10-01T00:00:00", TransactionType: "Charge", Amount: 500, ChargeTypeID: 1 },
    { TransactionID: 4, TransactionDate: "2026-10-01T00:00:00", TransactionType: "Charge", Amount: 40, ChargeTypeID: 2 },
  ],
  4: [{ TransactionID: 9, TransactionDate: "2025-11-01T00:00:00", TransactionType: "Charge", Amount: 1200 }],
  5: [{ TransactionID: 10, TransactionDate: "2026-10-01T00:00:00", TransactionType: "Charge", Amount: 75 }],
};

function applyFilters<T extends Record<string, unknown>>(rows: T[], filters: string | null): T[] {
  return rows.filter((row) =>
    (filters ?? "").split(";").filter(Boolean).every((clause) => {
      const [field, op, ...rest] = clause.split(",");
      const value = rest.join(",");
      const actual = row[field];
      if (op === "eq") return String(actual) === value;
      if (op === "ct") return String(actual ?? "").toLowerCase().includes(value.toLowerCase());
      if (op === "in") return value.replace(/[()]/g, "").split(",").includes(String(actual));
      return true;
    })
  );
}

/** Routes the fixture data like a Rent Manager instance would. */
export const fixtureApi: Handler = (req) => {
  if (req.method !== "GET") return undefined;
  const filters = req.query.get("filters");
  const page = Number(req.query.get("pagenumber") ?? 1);
  const list = (rows: Array<Record<string, unknown>>) => ({ body: page > 1 ? [] : applyFilters(rows, filters) });

  const child = /^\/(Tenants|Properties)\/(\d+)\/(\w+)$/.exec(req.path);
  if (child) {
    const id = Number(child[2]);
    if (child[1] === "Properties" && child[3] === "Units") return list(units.filter((u) => u.PropertyID === id));
    if (child[3] === "Transactions") return { body: page > 1 ? [] : (transactions[id] ?? []) };
    if (child[3] === "RecurringCharges") return { body: page > 1 ? [] : (recurringCharges[id] ?? []) };
    if (child[3] === "History") return { body: [] };
  }
  const single = /^\/Tenants\/(\d+)$/.exec(req.path);
  if (single) {
    const t = tenants.find((x) => x.TenantID === Number(single[1]));
    return t ? { body: t } : { status: 404, body: { UserMessage: "Not found" } };
  }

  switch (req.path) {
    case "/Properties":
      return list(properties);
    case "/Units":
      return list(units);
    case "/Tenants":
      return list(tenants);
    case "/Leases":
      return list(leases);
    case "/ChargeTypes":
      return list(chargeTypes);
    case "/UnitTypes":
      return list([]);
  }
  return undefined;
};
