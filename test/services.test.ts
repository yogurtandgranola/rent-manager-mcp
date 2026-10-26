import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLedger,
  computeAging,
  matchUnit,
  monthlyAmount,
  isRentChargeType,
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
  assert.deepEqual(aging.buckets, { current: 500, days31to60: 500, days61to90: 0, over90: 0 });
  assert.equal(aging.oldestUnpaidDate, "2026-09-01");
  assert.equal(aging.daysPastDue, 55);
  assert.equal(aging.lastPaymentDate, "2026-08-10");
  assert.equal(aging.lastPaymentAmount, 500);
});

test("aging reports nothing owed for a prepaid tenant", () => {
  const aging = computeAging(
    [
      { TransactionDate: "2026-10-01", TransactionType: "Charge", Amount: 500 },
      { TransactionDate: "2026-09-28", TransactionType: "Payment", Amount: 600 },
    ],
    "2026-10-26"
  );
  assert.equal(aging.oldestUnpaidDate, null);
  assert.equal(aging.daysPastDue, 0);
  assert.equal(aging.buckets.current, 0);
});

test("ledger running balance treats payments as reductions whatever their sign", () => {
  const rows = buildLedger(transactions[1] as Transaction[]);
  assert.deepEqual(rows.map((r) => r.running), [500, -90, 410, 450]);
  assert.equal(rows[1].signed, -590);
});

test("unit matching ignores 'Lot' prefixes and leading zeros", () => {
  assert.deepEqual(matchUnit(units, "lot 1").map((u) => u.UnitID), [101]);
  assert.deepEqual(matchUnit(units, "001").map((u) => u.UnitID), [101]);
  assert.deepEqual(matchUnit(units, "Lot 7").map((u) => u.UnitID), [201]);
  assert.deepEqual(matchUnit(units, "10").map((u) => u.UnitID), [110]);
});

test("recurring charges are converted to monthly amounts", () => {
  assert.equal(monthlyAmount({ RecurringChargeID: 1, Amount: 100 }), 100);
  assert.equal(monthlyAmount({ RecurringChargeID: 1, Amount: 1200, Frequency: "Annually" }), 100);
  assert.equal(monthlyAmount({ RecurringChargeID: 1, Amount: 300, FrequencyType: "Quarterly" }), 100);
  assert.equal(Math.round(monthlyAmount({ RecurringChargeID: 1, Amount: 120, Frequency: "Weekly" })), 520);
  assert.ok(isRentChargeType("Lot Rent") && isRentChargeType("Home Rent"));
  assert.ok(!isRentChargeType("Rent Late Fee") && !isRentChargeType("Water"));
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

test("tenant search uses the 'ct' operator and requires every word to match", async () => {
  const { service, calls } = makeService(fixtureApi);
  const found = await service.searchTenants("john smith");
  assert.deepEqual(found.map((t) => t.TenantID), [4, 5]);
  const filters = calls.filter((c) => c.path === "/Tenants").map((c) => c.query.get("filters"));
  assert.ok(filters.includes("LastName,ct,smith"));
  assert.ok(filters.every((f) => !/,cn,/.test(f ?? "")));
});

test("resolveTenant picks the single exact full-name match", async () => {
  const { service } = makeService(fixtureApi);
  assert.equal((await service.resolveTenant({ tenantName: "John Smith" })).TenantID, 4);
});

test("resolveTenant refuses to guess between partial matches", async () => {
  const { service } = makeService(fixtureApi);
  await assert.rejects(service.resolveTenant({ tenantName: "Smith" }), (err: Error) => {
    assert.ok(err instanceof UserFacingError);
    assert.match(err.message, /tenant ID 1\b/);
    assert.match(err.message, /tenant ID 3\b/);
    assert.match(err.message, /Lot 1 at Sunflower Estates/);
    return true;
  });
});

test("resolveTenant finds the current occupant by property and lot", async () => {
  const { service } = makeService(fixtureApi);
  const t = await service.resolveTenant({ propertyName: "Sunflower", unitName: "2" });
  assert.equal(t.TenantID, 2);
  await assert.rejects(service.resolveTenant({ propertyName: "Sunflower", unitName: "Lot 3" }), /may be vacant/);
});

// ── Reports ──

test("rent roll derives status, rent and other recurring charges", async () => {
  const { service } = makeService(fixtureApi);
  const roll = await service.getRentRoll(await service.resolveProperty("SUN"), true);
  const byUnit = Object.fromEntries(roll.rows.map((r) => [r.unitName, r]));

  assert.deepEqual(roll.rows.map((r) => r.unitName), ["Lot 1", "Lot 2", "Lot 3", "Lot 10"]);
  assert.equal(byUnit["Lot 1"].status, "Occupied");
  assert.equal(byUnit["Lot 1"].rent, 500); // the expired $450 charge is ignored
  assert.equal(byUnit["Lot 1"].otherRecurring, 40);
  assert.equal(byUnit["Lot 1"].moveInDate, "2021-04-01");
  assert.equal(byUnit["Lot 2"].status, "Notice");
  assert.equal(byUnit["Lot 2"].moveOutDate, "2026-11-30");
  assert.equal(byUnit["Lot 3"].status, "Vacant");
  assert.equal(byUnit["Lot 10"].status, "Pending Move-In");
  // Totals only cover lots with someone in place.
  assert.deepEqual(roll.chargeTotals, { "Lot Rent": 1025, Water: 40 });
});

test("delinquency report sorts by balance and estimates aging", async () => {
  const { service } = makeService(fixtureApi);
  const { records } = await service.getDelinquencies({ minBalance: 0.01, includeAging: true, includePastTenants: false });
  assert.deepEqual(records.map((r) => r.tenant.TenantID), [1, 5]);
  assert.equal(records[0].unitName, "Lot 1");
  assert.equal(records[0].aging?.buckets.current, 450);
  assert.equal(records[0].aging?.lastPaymentDate, "2026-09-08");

  const withPast = await service.getDelinquencies({ minBalance: 0.01, includeAging: false, includePastTenants: true });
  assert.equal(withPast.records[0].tenant.TenantID, 4);
});

test("delinquency report refuses to report zero when balances are missing", async () => {
  const { service } = makeService((req) =>
    req.path === "/Tenants" ? { body: [{ TenantID: 1, Name: "No Balance Field" }] } : fixtureApi(req)
  );
  await assert.rejects(
    service.getDelinquencies({ minBalance: 0.01, includeAging: false, includePastTenants: false }),
    /CurrentBalance/
  );
});

test("portfolio summary counts occupancy and receivables per property", async () => {
  const { service } = makeService(fixtureApi);
  const rows = await service.getPortfolioSummary();
  const sun = rows.find((r) => r.property.PropertyID === 1)!;
  assert.equal(sun.units, 4);
  assert.equal(sun.occupied, 2); // Lot 1 and Lot 2 (on notice); Lot 10 has not moved in
  assert.equal(sun.notice, 1);
  assert.equal(sun.vacant, 2);
  assert.equal(sun.receivables, 425);
  assert.equal(sun.delinquentCount, 1);
  assert.ok(!rows.some((r) => r.property.PropertyID === 4), "inactive property excluded");
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

test("one-letter name fragments are not sent as server-side filters", async () => {
  const { service, calls } = makeService(fixtureApi);
  await service.searchTenants("O'Brien");
  const filters = calls.filter((c) => c.path === "/Tenants").map((c) => c.query.get("filters"));
  assert.ok(!filters.some((f) => /,ct,o$/.test(f ?? "")), String(filters));
  assert.ok(filters.includes("LastName,ct,brien"));
});
