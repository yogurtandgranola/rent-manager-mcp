import assert from "node:assert/strict";
import { test } from "node:test";
import {
  balancesFromOpenItems,
  buildLedger,
  computeAging,
  isRentChargeType,
  matchUnit,
  monthlyAmount,
  UserFacingError,
} from "../src/services.js";
import type { Transaction } from "../src/types.js";
import { fixtureApi, transactions, units } from "./fixtures.js";
import { makeService } from "./helpers.js";

// ── Pure calculations ──

test("aging applies payments to the oldest charges first", () => {
  const txs: Transaction[] = [
    { TransactionDate: "2026-07-01", TransactionType: "Charge", Amount: 500 },
    { TransactionDate: "2026-07-05", TransactionType: "Payment", Amount: 500 },
    { TransactionDate: "2026-08-01", TransactionType: "Charge", Amount: 500 },
    { TransactionDate: "2026-08-10", TransactionType: "Payment", Amount: 500 },
    { TransactionDate: "2026-09-01", TransactionType: "Charge", Amount: 500 },
    { TransactionDate: "2026-10-01", TransactionType: "Charge", Amount: 500 },
    { TransactionDate: "2026-06-01", TransactionType: "Charge", Amount: 100 },
    { TransactionDate: "2026-06-15", TransactionType: "Credit", Amount: -100 },
  ];
  const aging = computeAging(txs, "2026-10-26");
  assert.equal(aging.balance, 1000);
  assert.deepEqual(aging.buckets, { current: 500, days31to60: 500, days61to90: 0, over90: 0 });
  assert.equal(aging.oldestUnpaidDate, "2026-09-01");
  assert.equal(aging.daysPastDue, 55);
  assert.equal(aging.lastPaymentDate, "2026-08-10");
  assert.equal(aging.lastPaymentAmount, 500);
});

test("aging ignores charges posted ahead of their due date", () => {
  const aging = computeAging(transactions[1] as Transaction[], "2026-10-26");
  assert.equal(aging.balance, 450);
  assert.equal(aging.buckets.current, 450);
});

test("aging reports a credit for a prepaid tenant", () => {
  const aging = computeAging(
    [
      { TransactionDate: "2026-10-01", TransactionType: "Charge", Amount: 500 },
      { TransactionDate: "2026-09-28", TransactionType: "Payment", Amount: -600 },
    ],
    "2026-10-26"
  );
  assert.equal(aging.balance, -100);
  assert.equal(aging.oldestUnpaidDate, null);
  assert.equal(aging.buckets.current, 0);
});

test("balances come from open charges and unapplied payments", () => {
  const balances = balancesFromOpenItems(
    [
      { ChargeID: 1, AccountID: 7, Amount: 500, AmountAllocated: 100, TransactionDate: "2026-08-01T00:00:00" },
      { ChargeID: 2, AccountID: 7, Amount: 500, AmountAllocated: 0, TransactionDate: "2026-10-01T00:00:00" },
      { ChargeID: 3, AccountID: 7, Amount: 500, AmountAllocated: 0, TransactionDate: "2026-11-01T00:00:00" },
      { ChargeID: 4, AccountID: 8, Amount: 10, AmountAllocated: 10, TransactionDate: "2026-10-01T00:00:00" },
    ],
    [
      { PaymentID: 1, AccountID: 7, Amount: 150, AmountAllocated: 0, TransactionDate: "2026-10-20T00:00:00" },
      { PaymentID: 2, AccountID: 7, Amount: 999, AmountAllocated: 0, TransactionDate: "2026-10-21T00:00:00", ReversalDate: "2026-10-22T00:00:00" },
    ],
    "2026-10-26"
  );
  const b = balances.get(7)!;
  assert.equal(b.balance, 750); // 400 + 500 open and due, less the 150 credit; November not due; reversed payment ignored
  assert.deepEqual(b.buckets, { current: 500, days31to60: 0, days61to90: 250, over90: 0 });
  assert.equal(balances.has(8), false);
});

test("ledger running balance treats negative payment amounts as payments", () => {
  const rows = buildLedger(transactions[1] as Transaction[]);
  assert.deepEqual(rows.map((r) => r.running), [500, -90, 410, 450, 950]);
  assert.equal(rows[1].signed, -590);
});

test("unit matching handles lot prefixes, leading zeros and SA-style names", () => {
  assert.deepEqual(matchUnit(units, "1").map((u) => u.UnitID), [101]);
  assert.deepEqual(matchUnit(units, "001").map((u) => u.UnitID), [101]);
  assert.deepEqual(matchUnit(units, "SA-1").map((u) => u.UnitID), [101]);
  assert.deepEqual(matchUnit(units, "lot 10").map((u) => u.UnitID), [110]);
  assert.deepEqual(matchUnit(units, "Lot 7").map((u) => u.UnitID), [201]);
});

test("recurring charges are converted to monthly amounts", () => {
  assert.equal(monthlyAmount({ RecurringChargeID: 1, Amount: 100, Frequency: 1 }), 100);
  assert.equal(monthlyAmount({ RecurringChargeID: 1, Amount: 1200, Frequency: "Annually" }), 100);
  assert.equal(monthlyAmount({ RecurringChargeID: 1, Amount: 300, FrequencyType: "Quarterly" }), 100);
  assert.equal(Math.round(monthlyAmount({ RecurringChargeID: 1, Amount: 120, Frequency: "Weekly" })), 520);
  for (const rent of ["Lot Rent", "Park Owned Home Monthly Rent", "Rent Charge"]) assert.ok(isRentChargeType(rent), rent);
  for (const other of ["Rent Late Fee", "Water Utility", "Security Deposits"]) assert.ok(!isRentChargeType(other), other);
});

// ── Lookups ──

test("resolves properties by exact name, short name, ID, and unique partial", async () => {
  const { service } = makeService(fixtureApi);
  assert.equal((await service.resolveProperty("sunflower estates")).PropertyID, 1);
  assert.equal((await service.resolveProperty("SUN")).PropertyID, 1);
  assert.equal((await service.resolveProperty("3")).PropertyID, 3);
  assert.equal((await service.resolveProperty("sunflower")).PropertyID, 1);
});

test("an ambiguous property name lists the choices instead of guessing", async () => {
  const { service } = makeService(fixtureApi);
  await assert.rejects(service.resolveProperty("Oak"), (err: Error) => {
    assert.ok(err instanceof UserFacingError);
    assert.match(err.message, /Oak Park/);
    assert.match(err.message, /Oak Ridge/);
    return true;
  });
});

test("the property list is cached between calls", async () => {
  const { service, calls } = makeService(fixtureApi);
  await service.resolveProperty("SUN");
  await service.resolveProperty("Oak Park");
  assert.equal(calls.filter((c) => c.path === "/Properties").length, 1);
});

test("tenant search uses 'ct', never filters on fields tenants don't have, and needs every word", async () => {
  const { service, calls } = makeService(fixtureApi);
  const found = await service.searchTenants("john smith");
  assert.deepEqual(found.map((t) => t.TenantID), [4, 5]);
  const filters = calls.filter((c) => c.path === "/Tenants").map((c) => c.query.get("filters") ?? "");
  assert.ok(filters.includes("LastName,ct,smith"));
  assert.ok(filters.every((f) => !/,cn,|IsActive|UnitID|Email/.test(f)), filters.join(" | "));
});

test("active-only search filters on Status", async () => {
  const { service } = makeService(fixtureApi);
  const found = await service.searchTenants("smith", { activeOnly: true });
  assert.deepEqual(found.map((t) => t.TenantID).sort(), [1, 5]);
});

test("email search goes through tenant contacts", async () => {
  const { service } = makeService(fixtureApi);
  assert.deepEqual((await service.searchTenants("alice@example.com")).map((t) => t.TenantID), [1]);
});

test("resolveTenant picks the single exact full-name match", async () => {
  const { service } = makeService(fixtureApi);
  assert.equal((await service.resolveTenant({ tenantName: "John Smith" })).TenantID, 4);
});

test("resolveTenant refuses to guess, and labels matches with lots from their leases", async () => {
  const { service } = makeService(fixtureApi);
  await assert.rejects(service.resolveTenant({ tenantName: "Smith" }), (err: Error) => {
    assert.ok(err instanceof UserFacingError);
    assert.match(err.message, /tenant ID 1\b/);
    assert.match(err.message, /tenant ID 3\b/);
    assert.match(err.message, /SA-1 at Sunflower Estates/);
    assert.match(err.message, /future/);
    return true;
  });
});

test("resolveTenant finds the current occupant of a lot through leases", async () => {
  const { service } = makeService(fixtureApi);
  assert.equal((await service.resolveTenant({ propertyName: "Sunflower", unitName: "2" })).TenantID, 2);
  await assert.rejects(service.resolveTenant({ propertyName: "Sunflower", unitName: "SA-3" }), /may be vacant/);
});

// ── Reports ──

test("rent roll derives status, rent by charge description, and balances due today", async () => {
  const { service, calls } = makeService(fixtureApi);
  const roll = await service.getRentRoll(await service.resolveProperty("SUN"), true);
  const byUnit = Object.fromEntries(roll.rows.map((r) => [r.unitName, r]));

  assert.deepEqual(roll.rows.map((r) => r.unitName), ["SA-1", "SA-2", "SA-3", "SA-10"]);
  assert.equal(byUnit["SA-1"].status, "Occupied");
  assert.equal(byUnit["SA-1"].unitType, "Lot");
  assert.equal(byUnit["SA-1"].rent, 500); // the expired $450 charge is ignored
  assert.equal(byUnit["SA-1"].otherRecurring, 40);
  assert.equal(byUnit["SA-1"].balance, 450);
  assert.equal(byUnit["SA-2"].status, "Notice");
  assert.equal(byUnit["SA-2"].rent, 750); // lot rent + park owned home rent
  assert.equal(byUnit["SA-2"].balance, 0); // November charge isn't due yet
  assert.equal(byUnit["SA-3"].status, "Vacant");
  assert.equal(byUnit["SA-10"].status, "Pending Move-In");
  assert.deepEqual(roll.chargeTotals, { "Lot Rent": 1025, "Park Owned Home Monthly Rent": 225, "Water Utility": 40 });
  assert.equal(roll.unlinked.length, 0);
  // Recurring charges come from one bulk request, not one per tenant.
  assert.equal(calls.filter((c) => /\/Tenants\/\d+\/RecurringCharges/.test(c.path)).length, 0);
});

test("delinquency report uses open charges, skips charges not yet due, and shows the last real payment", async () => {
  const { service } = makeService(fixtureApi);
  const { records, exact } = await service.getDelinquencies({ minBalance: 0.01, includeAging: true, includePastTenants: false });
  assert.equal(exact, true);
  assert.deepEqual(records.map((r) => [r.tenant.TenantID, r.balance]), [[1, 450], [5, 75]]);
  assert.equal(records[0].unitName, "SA-1");
  assert.equal(records[0].aging?.buckets.current, 450);
  assert.equal(records[0].aging?.lastPaymentDate, "2026-09-08"); // the bounced 10/05 payment doesn't count
  assert.equal(records[0].aging?.lastPaymentAmount, 590);

  const withPast = await service.getDelinquencies({ minBalance: 0.01, includeAging: false, includePastTenants: true });
  assert.deepEqual(withPast.records.map((r) => r.tenant.TenantID), [4, 1, 5]);
  assert.equal(withPast.records[0].balance, 1200);
});

test("delinquency for one property filters charges by property", async () => {
  const { service, calls } = makeService(fixtureApi);
  const { records } = await service.getDelinquencies({ propertyId: 1, minBalance: 0.01, includeAging: true, includePastTenants: false });
  assert.deepEqual(records.map((r) => r.tenant.TenantID), [1]);
  assert.ok(calls.some((c) => c.path === "/Charges" && c.query.get("filters") === "IsFullyAllocated,eq,false;PropertyID,eq,1"));
});

test("delinquency falls back to each ledger when open charges aren't available", async () => {
  const { service } = makeService((req) => (req.path === "/Charges" ? { status: 404 } : fixtureApi(req)));
  const { records, exact } = await service.getDelinquencies({ minBalance: 0.01, includeAging: true, includePastTenants: false });
  assert.equal(exact, false);
  assert.deepEqual(records.map((r) => [r.tenant.TenantID, r.balance]), [[1, 450], [5, 75]]);
});

test("portfolio summary counts occupancy and receivables per property", async () => {
  const { service } = makeService(fixtureApi);
  const rows = await service.getPortfolioSummary();
  const sun = rows.find((r) => r.property.PropertyID === 1)!;
  assert.equal(sun.units, 4);
  assert.equal(sun.occupied, 2); // SA-1 and SA-2 (on notice); SA-10 hasn't moved in
  assert.equal(sun.notice, 1);
  assert.equal(sun.vacant, 2);
  assert.equal(sun.receivables, 450);
  assert.equal(sun.delinquentCount, 1);
  const oak = rows.find((r) => r.property.PropertyID === 2)!;
  assert.equal(oak.occupied, 1);
  assert.equal(oak.delinquentAmount, 75);
  assert.ok(!rows.some((r) => r.property.PropertyID === 4), "inactive property excluded");
});

test("work orders filter through linked properties and get status names from lookups", async () => {
  const { service } = makeService(fixtureApi);
  const all = await service.getWorkOrders({ includeClosed: false });
  assert.deepEqual(all.map((i) => [i.ServiceManagerIssueID, i.PropertyID, i.Status?.Name, i.Priority?.Name]), [
    [6, 2, "New", "High"],
    [5, 1, "Work In Progress", "Low"],
  ]);
  const sun = await service.getWorkOrders({ propertyId: 1, includeClosed: true });
  assert.deepEqual(sun.map((i) => i.ServiceManagerIssueID).sort(), [5, 7]);
});

// ── Writes ──

test("notes go to /Tenants/{id}/History with a local timestamp", async () => {
  const { service, calls } = makeService((req) =>
    req.method === "POST" && req.path === "/Tenants/1/History" ? { body: { HistoryID: 77 } } : fixtureApi(req)
  );
  const saved = await service.addNote(1, "Called about late rent", 5);
  assert.equal(saved.historyId, 77);
  const post = calls.find((c) => c.method === "POST" && c.path === "/Tenants/1/History")!;
  assert.deepEqual(post.body, { Note: "Called about late rent", HistoryDate: "2026-10-26T12:00:00", HistoryCategoryID: 5 });
});

test("note writing falls back to /Tenants/HistoryNotes only when the first route is missing", async () => {
  const { service, calls } = makeService((req) =>
    req.method === "POST" && req.path === "/Tenants/HistoryNotes" ? { body: [{ HistoryID: 88 }] } : fixtureApi(req)
  );
  assert.equal((await service.addNote(1, "Hi")).historyId, 88);
  const fallback = calls.find((c) => c.path === "/Tenants/HistoryNotes")!;
  assert.deepEqual(fallback.body, [{ Note: "Hi", HistoryDate: "2026-10-26T12:00:00", ParentID: 1 }]);

  const rejected = makeService((req) =>
    req.method === "POST" && req.path === "/Tenants/1/History" ? { status: 400, body: { UserMessage: "Category required" } } : fixtureApi(req)
  );
  await assert.rejects(rejected.service.addNote(1, "Hi"), /Category required/);
  assert.ok(!rejected.calls.some((c) => c.path === "/Tenants/HistoryNotes"), "no second write after a real rejection");
});

test("the default note category comes from config", async () => {
  const { service, calls } = makeService(
    (req) => (req.method === "POST" && req.path === "/Tenants/1/History" ? { body: { HistoryID: 1 } } : fixtureApi(req)),
    { noteCategoryId: 9 }
  );
  await service.addNote(1, "x");
  assert.equal((calls.find((c) => c.path === "/Tenants/1/History")!.body as { HistoryCategoryID: number }).HistoryCategoryID, 9);
});
