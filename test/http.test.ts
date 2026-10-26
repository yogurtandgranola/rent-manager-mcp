import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GoogleOAuthProvider, Sealer, type AuthConfig } from "../src/auth.js";
import { loadAuthConfig } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { fixtureApi } from "./fixtures.js";
import { makeService } from "./helpers.js";

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const GOOGLE_CLIENT_ID = "google-client.apps.googleusercontent.com";

// Google's token endpoint, faked: each code maps to the account that "signed in".
const googleAccounts = new Map<string, { email: string; hd?: string; verified?: boolean }>();
const fakeGoogle = (async (url: string | URL, init?: RequestInit) => {
  assert.equal(String(url), "https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(String(init?.body));
  const account = googleAccounts.get(form.get("code") ?? "");
  if (!account) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  const claims = {
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: account.email,
    email_verified: account.verified ?? true,
    hd: account.hd,
    name: account.email.split("@")[0],
  };
  const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  return new Response(JSON.stringify({ id_token: idToken, access_token: "g" }), { status: 200 });
}) as typeof fetch;

let server: Server;
let base: string;
let authConfig: AuthConfig;

before(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  authConfig = {
    publicUrl: new URL(base),
    secret: "x".repeat(40),
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: "google-secret",
    allowedDomains: ["cornellcommunities.com"],
    allowedEmails: ["contractor@gmail.com"],
    editorEmails: ["owner@cornellcommunities.com"],
    extraRedirectHosts: [],
  };
  const { service } = makeService(fixtureApi);
  server.on("request", createHttpApp(service, new GoogleOAuthProvider(authConfig, fakeGoogle), "test"));
});

after(() => server.close());

async function register(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Walks the browser part of sign-in. Returns the final redirect, which should land back on Claude. */
async function signIn(clientId: string, account: { email: string; hd?: string; verified?: boolean }) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = await fetch(
    `${base}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "claude-state",
    })}`,
    { redirect: "manual" }
  );
  assert.equal(authorize.status, 302);
  const toGoogle = new URL(authorize.headers.get("location")!);
  assert.equal(toGoogle.origin, "https://accounts.google.com");
  assert.equal(toGoogle.searchParams.get("hd"), "cornellcommunities.com");
  assert.equal(toGoogle.searchParams.get("redirect_uri"), `${base}/oauth/google/callback`);

  const googleCode = randomBytes(8).toString("hex");
  googleAccounts.set(googleCode, account);
  const callback = await fetch(
    `${base}/oauth/google/callback?${new URLSearchParams({ code: googleCode, state: toGoogle.searchParams.get("state")! })}`,
    { redirect: "manual" }
  );
  return { callback, verifier };
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function login(email: string, hd?: string) {
  const clientId = await register();
  const { callback, verifier } = await signIn(clientId, { email, hd });
  assert.equal(callback.status, 302, await callback.text());
  const back = new URL(callback.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, CLAUDE_CALLBACK);
  assert.equal(back.searchParams.get("state"), "claude-state");
  const code = back.searchParams.get("code")!;
  const token = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK });
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return { clientId, code, verifier, tokens: token.body };
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: "claude-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } })
  );
  return client;
}

test("health shows the URLs to paste into Claude and Google", async () => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.connectorUrl, `${base}/mcp`);
  assert.equal(health.googleRedirectUri, `${base}/oauth/google/callback`);
});

test("advertises OAuth metadata for Claude to discover", async () => {
  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.registration_endpoint, `${base}/register`);
  assert.ok(as.code_challenge_methods_supported.includes("S256"));
});

test("only Claude and loopback callbacks can register", async () => {
  const reg = (uri: string) =>
    fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: "none" }),
    }).then((r) => r.status);
  assert.equal(await reg("https://claude.com/api/mcp/auth_callback"), 201);
  assert.equal(await reg("http://localhost:54321/callback"), 201);
  assert.equal(await reg("https://evil.example/callback"), 400);
  assert.equal(await reg("https://claude.ai.evil.example/cb"), 400);
  assert.equal(await reg("http://claude.ai/api/mcp/auth_callback"), 400);
});

test("rejects MCP calls without a token and points to the metadata", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=".*oauth-protected-resource\/mcp"/);
});

test("team members get the read-only tools", async () => {
  const { tokens } = await login("manager@cornellcommunities.com", "cornellcommunities.com");
  const client = await mcpClient(tokens.access_token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.equal(names.length, 11);
  assert.ok(!names.includes("add_tenant_note") && !names.includes("create_work_order"));

  const res = (await client.callTool({ name: "test_connection", arguments: {} })) as { content: Array<{ text: string }> };
  assert.match(res.content[0].text, /Signed in as: manager@cornellcommunities\.com/);
  assert.match(res.content[0].text, /read-only/);
  await client.close();
});

test("editors also get the write tools", async () => {
  const { tokens } = await login("Owner@CornellCommunities.com", "cornellcommunities.com");
  const client = await mcpClient(tokens.access_token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("add_tenant_note") && names.includes("create_work_order"));
  await client.close();
});

test("individually allowed outside addresses can sign in", async () => {
  const { tokens } = await login("contractor@gmail.com");
  assert.ok(tokens.access_token);
});

test("accounts outside the company are refused at the Google step", async () => {
  const { callback } = await signIn(await register(), { email: "someone@gmail.com" });
  assert.equal(callback.status, 403);
  assert.match(await callback.text(), /someone@gmail\.com is not allowed/);

  const unverified = await signIn(await register(), { email: "x@cornellcommunities.com", hd: "cornellcommunities.com", verified: false });
  assert.equal(unverified.callback.status, 502);
});

test("authorization codes work once and need the right PKCE verifier", async () => {
  const { clientId, code, verifier } = await login("manager@cornellcommunities.com", "cornellcommunities.com");
  const replay = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK });
  assert.equal(replay.status, 400);

  const fresh = await register();
  const { callback } = await signIn(fresh, { email: "manager@cornellcommunities.com", hd: "cornellcommunities.com" });
  const freshCode = new URL(callback.headers.get("location")!).searchParams.get("code")!;
  const wrongVerifier = await tokenRequest({
    grant_type: "authorization_code",
    code: freshCode,
    code_verifier: randomBytes(32).toString("base64url"),
    client_id: fresh,
    redirect_uri: CLAUDE_CALLBACK,
  });
  assert.equal(wrongVerifier.status, 400);
});

test("refresh tokens issue a new access token", async () => {
  const { clientId, tokens } = await login("manager@cornellcommunities.com", "cornellcommunities.com");
  const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId });
  assert.equal(refreshed.status, 200);
  const client = await mcpClient(refreshed.body.access_token);
  assert.equal((await client.listTools()).tools.length, 11);
  await client.close();
});

test("removing someone from the allow list cuts off existing tokens", async () => {
  const { tokens } = await login("contractor@gmail.com");
  authConfig.allowedEmails.splice(authConfig.allowedEmails.indexOf("contractor@gmail.com"), 1);
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
  } finally {
    authConfig.allowedEmails.push("contractor@gmail.com");
  }
});

test("forged or swapped tokens are rejected", async () => {
  const other = new Sealer("y".repeat(40));
  const forged = other.seal("access", { email: "owner@cornellcommunities.com", clientId: "x" }, 3600);
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${forged}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 401);

  // A refresh token is not an access token, even though both are sealed by this server.
  const { tokens } = await login("manager@cornellcommunities.com", "cornellcommunities.com");
  const swapped = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.refresh_token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(swapped.status, 401);
});

test("hosted config fails closed", () => {
  const env = {
    PUBLIC_URL: "https://rm.example.com",
    AUTH_SECRET: "s".repeat(40),
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    ALLOWED_DOMAINS: "@CornellCommunities.com",
    EDITOR_EMAILS: "Owner@cornellcommunities.com, second@cornellcommunities.com",
  };
  const cfg = loadAuthConfig(env);
  assert.deepEqual(cfg.allowedDomains, ["cornellcommunities.com"]);
  assert.deepEqual(cfg.editorEmails, ["owner@cornellcommunities.com", "second@cornellcommunities.com"]);
  assert.throws(() => loadAuthConfig({ ...env, ALLOWED_DOMAINS: "", EDITOR_EMAILS: "" }), /ALLOWED_DOMAINS/);
  assert.throws(() => loadAuthConfig({ ...env, AUTH_SECRET: "short" }), /32 characters/);
  assert.throws(() => loadAuthConfig({ ...env, PUBLIC_URL: "http://rm.example.com" }), /https/);
  assert.equal(loadAuthConfig({ ...env, PUBLIC_URL: "", RENDER_EXTERNAL_URL: "https://x.onrender.com" }).publicUrl.host, "x.onrender.com");
});

async function registerConfidential(): Promise<{ client_id: string; client_secret: string }> {
  // The shape claude.ai sends: a confidential client using client_secret_post.
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { client_id: string; client_secret: string };
}

test("client IDs are short and secrets are stable", async () => {
  const client = await registerConfidential();
  assert.ok(client.client_id.length < 200, `client_id is ${client.client_id.length} chars`);
  assert.ok(client.client_secret.length >= 40);
  const meta = await (await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }),
  })).json();
  assert.equal(meta.client_secret, undefined);
});

test("confidential clients can sign in with the secret in the form or as Basic auth", async () => {
  for (const style of ["post", "basic"] as const) {
    const client = await registerConfidential();
    const { callback, verifier } = await signIn(client.client_id, { email: "manager@cornellcommunities.com", hd: "cornellcommunities.com" });
    const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;
    const form = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK };
    const res = await fetch(`${base}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(style === "basic"
          ? { Authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}` }
          : {}),
      },
      body: new URLSearchParams(style === "post" ? { ...form, client_id: client.client_id, client_secret: client.client_secret } : form),
    });
    assert.equal(res.status, 200, `${style}: ${await res.text()}`);
  }
});

test("a confidential client's wrong secret or a tampered client ID is refused", async () => {
  const client = await registerConfidential();
  const { callback, verifier } = await signIn(client.client_id, { email: "manager@cornellcommunities.com", hd: "cornellcommunities.com" });
  const code = new URL(callback.headers.get("location")!).searchParams.get("code")!;
  const wrong = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, client_secret: "nope", redirect_uri: CLAUDE_CALLBACK });
  assert.equal(wrong.status, 400);

  // Swap in an attacker's redirect but keep the old signature.
  const [, tag] = client.client_id.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ r: ["https://evil.example/cb"], p: 1, t: 0 })).toString("base64url");
  const res = await fetch(
    `${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: `${forgedBody}.${tag}`, redirect_uri: "https://evil.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`,
    { redirect: "manual" }
  );
  assert.notEqual(res.status, 302);
});

test("many registrations in a row are not rate limited", async () => {
  for (let i = 0; i < 25; i++) await registerConfidential();
});
