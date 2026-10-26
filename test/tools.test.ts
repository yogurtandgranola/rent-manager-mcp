import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import type { RentManagerConfig } from "../src/types.js";
import { fixtureApi } from "./fixtures.js";
import { makeService, type Handler } from "./helpers.js";

async function connect(handler: Handler = fixtureApi, config: Partial<RentManagerConfig> = {}) {
  const { service, calls } = makeService(handler, config);
  const server = new McpServer({ name: "rent-manager-test", version: "0.0.0" });
  registerTools(server, service, { allowWrites: !service.config.readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
  };
  return { client, call, calls };
}

test("registers read and write tools, with read-only hints on reads", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_tenant_note",
    "create_work_order",
    "get_delinquencies",
    "get_portfolio_summary",
    "get_rent_roll",
    "get_tenant_balance",
    "get_tenant_ledger",
    "get_tenant_notes",
    "get_work_orders",
    "list_properties",
    "rm_api_get",
    "search_tenants",
    "test_connection",
  ]);
  for (const t of tools) {
    const writes = t.name === "add_tenant_note" || t.name === "create_work_order";
    assert.equal(t.annotations?.readOnlyHint, !writes, t.name);
  }
});

test("RM_READ_ONLY hides the write tools", async () => {
  const { client } = await connect(fixtureApi, { readOnly: true });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!names.includes("add_tenant_note"));
  assert.ok(!names.includes("create_work_order"));
});

test("get_rent_roll renders a summary and unit table", async () => {
  const { call } = await connect();
  const { text, isError } = await call("get_rent_roll", { property_name: "Sunflower" });
  assert.equal(isError, false, text);
  assert.match(text, /Rent Roll - Sunflower Estates/);
  assert.match(text, /\*\*4\*\* units \| Occupied \*\*2\*\* \(50\.0%\)/);
  assert.match(text, /Monthly rent \*\*\$1,250\.00\*\*/);
  assert.match(text, /\| SA-2 \| Lot \| Bob Jones \| Notice \(out 2026-11-30\) \| 2019-06-15 \| \$750\.00 \|/);
  assert.match(text, /\| SA-10 \| Lot \| Carol Smith \| Pending Move-In \|/);
});

test("get_rent_roll csv has one column per charge type", async () => {
  const { call } = await connect();
  const { text } = await call("get_rent_roll", { property_name: "SUN", format: "csv" });
  const [header, firstRow] = text.trim().split("\n");
  assert.equal(
    header,
    "Unit,Unit Type,Status,Tenant,Tenant IDs,Move In,Move Out,Monthly Rent,Other Recurring,Balance,Lot Rent,Park Owned Home Monthly Rent,Water Utility"
  );
  assert.equal(firstRow, "SA-1,Lot,Occupied,Alice Smith,1,2021-04-01,,500.00,40.00,450.00,500.00,0.00,40.00");
});

test("get_tenant_ledger lists matches instead of picking the first one", async () => {
  const { call, calls } = await connect();
  const { text, isError } = await call("get_tenant_ledger", { tenant_name: "Smith" });
  assert.equal(isError, true);
  assert.match(text, /tenants match/);
  assert.ok(!calls.some((c) => /Transactions/.test(c.path)), "no ledger fetched for an ambiguous tenant");
});

test("get_tenant_ledger shows a running balance and flags charges posted early", async () => {
  const { call } = await connect();
  const { text, isError } = await call("get_tenant_ledger", { tenant_id: 1 });
  assert.equal(isError, false, text);
  assert.match(text, /\*\*Unit:\*\* SA-1 .*\*\*Balance due today:\*\* \$450\.00/);
  assert.match(text, /\| 2026-09-08 \| Payment \| Payment Received - Check #: 1042 \| - \| \$590\.00 \| -\$90\.00 \|/);
  assert.match(text, /\| 2026-10-01 \| Charge \| Water Utility \| \$40\.00 \| - \| \$450\.00 \|/);
  assert.match(text, /\| 2026-11-01 \(scheduled\) \| Charge \| Lot Rent \|/);
  assert.doesNotMatch(text, /differs from/);
});

test("report tools work against an instance without IsActive, UnitID or balance fields", async () => {
  const { call, calls } = await connect();
  for (const name of ["get_portfolio_summary", "get_delinquencies"]) {
    const { text, isError } = await call(name);
    assert.equal(isError, false, `${name}: ${text}`);
  }
  const { text } = await call("get_delinquencies");
  assert.match(text, /\| Alice Smith \| 1 \| SA-1 \| Sunflower Estates \| \$450\.00 \|/);
  assert.ok(!calls.some((c) => c.status === 400), "no request was rejected");
});

test("add_tenant_note will not write when the tenant is ambiguous", async () => {
  const { call, calls } = await connect();
  const { isError } = await call("add_tenant_note", { tenant_name: "Smith", note: "hello" });
  assert.equal(isError, true);
  assert.ok(!calls.some((c) => c.method === "POST" && c.path !== "/Authentication/AuthorizeUser"));
});

test("create_work_order posts a Service Manager issue for the resolved lot", async () => {
  const { call, calls } = await connect((req) => {
    if (req.method === "POST" && req.path === "/ServiceManagerIssues") return { body: { ServiceManagerIssueID: 555 } };
    if (req.method === "POST" && /\/555\/Link(Property|Unit)$/.test(req.path)) return { status: 204 };
    return fixtureApi(req);
  });
  const { text, isError } = await call("create_work_order", {
    title: "Water leak",
    description: "Leak under the home",
    property_name: "Sunflower",
    unit_name: "1",
    tenant_id: 1,
  });
  assert.equal(isError, false, text);
  assert.match(text, /Issue ID: 555/);
  assert.doesNotMatch(text, /Warning/);
  const posts = calls.filter((c) => c.method === "POST" && c.path.startsWith("/ServiceManagerIssues"));
  // Issues have no property, unit or tenant fields: they're linked afterwards.
  assert.deepEqual(posts[0].body, {
    Title: "Water leak",
    Description: "Leak under the home\n\nTenant: Alice Smith (tenant ID 1)",
    IsClosed: false,
  });
  assert.deepEqual(posts.slice(1).map((c) => [c.path, c.query.toString()]), [
    ["/ServiceManagerIssues/555/LinkProperty", "propertyID=1"],
    ["/ServiceManagerIssues/555/LinkUnit", "unitID=101"],
  ]);
});

test("create_work_order reports a link failure without hiding the new issue", async () => {
  const { call } = await connect((req) => {
    if (req.method === "POST" && req.path === "/ServiceManagerIssues") return { body: { ServiceManagerIssueID: 556 } };
    if (req.method === "POST" && req.path.endsWith("/LinkUnit")) return { status: 400, body: { UserMessage: "Unit not on property" } };
    return fixtureApi(req);
  });
  const { text, isError } = await call("create_work_order", { title: "x", description: "y", property_name: "SUN", unit_name: "1" });
  assert.equal(isError, false, text);
  assert.match(text, /Issue ID: 556/);
  assert.match(text, /Warning: Couldn't link the lot: .*Unit not on property/);
});

test("rm_api_get passes query options through and blocks auth endpoints", async () => {
  const { call, calls } = await connect();
  const ok = await call("rm_api_get", { path: "/Units", filters: "PropertyID,eq,2", pagesize: 10 });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /"UnitID": 201/);
  const req = calls.find((c) => c.path === "/Units")!;
  assert.equal(req.query.get("filters"), "PropertyID,eq,2");
  assert.equal(req.query.get("pagesize"), "10");

  assert.equal((await call("rm_api_get", { path: "Authentication/AuthorizeUser" })).isError, true);
  assert.equal((await call("rm_api_get", { path: "../etc" })).isError, true);
});

test("API errors come back as tool errors with Rent Manager's message", async () => {
  const { call } = await connect((req) =>
    req.path === "/Properties" ? { status: 403, body: { UserMessage: "User does not have access" } } : fixtureApi(req)
  );
  const { text, isError } = await call("list_properties");
  assert.equal(isError, true);
  assert.match(text, /HTTP 403.*User does not have access.*lacks permission/);
});
