import assert from "node:assert/strict";
import { test } from "node:test";
import { RentManagerClient, RentManagerError, rql, rqlValue } from "../src/rent-manager-client.js";
import { mockFetch, testConfig } from "./helpers.js";

function client(handler: Parameters<typeof mockFetch>[0], overrides = {}) {
  const mock = mockFetch(handler);
  const c = new RentManagerClient(testConfig(overrides), mock.fetch);
  c.retryDelayMs = 0;
  return { c, calls: mock.calls };
}

test("logs in with AuthorizeUser and sends the bare token in X-RM12Api-ApiToken", async () => {
  const { c, calls } = client((req) => (req.path === "/Properties" ? { body: [] } : undefined));
  await c.get("/Properties");

  const [login, get] = calls;
  assert.equal(login.method, "POST");
  assert.equal(login.path, "/Authentication/AuthorizeUser");
  assert.deepEqual(login.body, { Username: "api-user", Password: "secret", LocationID: 1 });
  assert.equal(get.headers["X-RM12Api-ApiToken"], "token-1");
  assert.equal(get.headers["Authorization"], undefined);
});

test("also accepts a { Token } object from AuthorizeUser", async () => {
  const { c, calls } = client((req) =>
    req.path === "/Authentication/AuthorizeUser" ? { body: { Token: "obj-token" } } : { body: [] }
  );
  await c.get("/Units");
  assert.equal(calls[1].headers["X-RM12Api-ApiToken"], "obj-token");
});

test("concurrent requests share a single login", async () => {
  const { c, calls } = client((req) => (req.path === "/Units" ? { body: [] } : undefined));
  await Promise.all([c.get("/Units"), c.get("/Units"), c.get("/Units")]);
  assert.equal(calls.filter((r) => r.path === "/Authentication/AuthorizeUser").length, 1);
});

test("re-authenticates once when a token expires", async () => {
  let logins = 0;
  const { c } = client((req) => {
    if (req.path === "/Authentication/AuthorizeUser") return { body: `token-${++logins}` };
    return req.headers["X-RM12Api-ApiToken"] === "token-1" ? { status: 401 } : { body: [{ ok: true }] };
  });
  assert.deepEqual(await c.get("/Tenants"), [{ ok: true }]);
  assert.equal(logins, 2);
});

test("a rejected static token without username/password gives a clear error", async () => {
  const { c } = client(() => ({ status: 401 }), { username: undefined, password: undefined, apiToken: "static" });
  await assert.rejects(c.get("/Tenants"), (err: RentManagerError) => err.status === 401 && /RM_USERNAME/.test(err.message));
});

test("builds RQL query parameters with the names Rent Manager expects", async () => {
  const { c, calls } = client((req) => (req.path === "/Tenants" ? { body: [] } : undefined));
  await c.get("/Tenants", {
    filters: [rql.eq("PropertyID", 3), rql.ct("LastName", "Smith")],
    fields: ["TenantID", "Name"],
    embed: ["Leases"],
    orderby: ["Name"],
  });
  const q = calls[1].query;
  assert.equal(q.get("filters"), "PropertyID,eq,3;LastName,ct,Smith");
  assert.equal(q.get("fields"), "TenantID,Name");
  assert.equal(q.get("embed"), "Leases");
  assert.equal(q.get("orderby"), "Name");
});

test("rqlValue strips characters that would break a filter", () => {
  assert.equal(rqlValue("Smith, John; (Jr)"), "Smith John Jr");
  assert.equal(rql.in("UnitID", [1, 2, 3]), "UnitID,in,(1,2,3)");
});

test("getAll follows pages until a short page", async () => {
  const { c, calls } = client((req) => {
    if (req.path !== "/Units") return undefined;
    const page = Number(req.query.get("pagenumber"));
    const size = Number(req.query.get("pagesize"));
    const count = page < 3 ? size : 1;
    return { body: Array.from({ length: count }, (_, i) => ({ UnitID: (page - 1) * size + i + 1 })) };
  });
  const rows = await c.getAll<{ UnitID: number }>("/Units", { pagesize: 2 });
  assert.deepEqual(rows.map((r) => r.UnitID), [1, 2, 3, 4, 5]);
  assert.equal(calls.filter((r) => r.path === "/Units").length, 3);
});

test("getAll stops when X-Total-Results is reached", async () => {
  const { c, calls } = client((req) =>
    req.path === "/Units" ? { body: [{ UnitID: 1 }, { UnitID: 2 }], headers: { "X-Total-Results": "2" } } : undefined
  );
  assert.equal((await c.getAll("/Units", { pagesize: 2 })).length, 2);
  assert.equal(calls.filter((r) => r.path === "/Units").length, 1);
});

test("a GET rejected for its field list is retried without fields", async () => {
  const { c, calls } = client((req) => {
    if (req.path !== "/Units") return undefined;
    return req.query.has("fields") ? { status: 400, body: { DeveloperMessage: "Invalid field UnitTypeID" } } : { body: [{ UnitID: 9 }] };
  });
  assert.deepEqual(await c.get("/Units", { fields: ["UnitID", "UnitTypeID"] }), [{ UnitID: 9 }]);
  assert.equal(calls.filter((r) => r.path === "/Units").length, 2);
});

test("GETs retry on 503 but writes never do", async () => {
  let gets = 0;
  let posts = 0;
  const { c } = client((req) => {
    if (req.path === "/Units") return ++gets < 2 ? { status: 503 } : { body: [] };
    if (req.path === "/ServiceManagerIssues") {
      posts++;
      return { status: 503, body: { UserMessage: "Service unavailable" } };
    }
    return undefined;
  });
  await c.get("/Units");
  assert.equal(gets, 2);
  await assert.rejects(c.post("/ServiceManagerIssues", { Title: "x" }), RentManagerError);
  assert.equal(posts, 1);
});

test("error messages carry Rent Manager's UserMessage and DeveloperMessage", async () => {
  const { c } = client((req) =>
    req.path === "/Tenants" ? { status: 400, body: { UserMessage: "Bad filter", DeveloperMessage: "Unknown operator cn" } } : undefined
  );
  await assert.rejects(c.get("/Tenants"), (err: RentManagerError) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /Bad filter \| Unknown operator cn/);
    return true;
  });
});

test("an HTML page instead of JSON explains the base URL is wrong", async () => {
  const html = new RentManagerClient(testConfig(), (async () =>
    new Response("<!DOCTYPE html><html>Login</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch);
  await assert.rejects(html.get("/Properties"), /api\.rentmanager\.com/);
});
