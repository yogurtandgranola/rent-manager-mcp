import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// Sign-in for the hosted (HTTP) server.
//
// Claude's connector speaks OAuth to this server; this server sends people to
// Google to prove who they are, then issues its own tokens. Nothing is stored:
// client registrations, login state, codes and tokens are all AES-GCM sealed
// with a key derived from AUTH_SECRET, so restarts and redeploys don't sign
// anyone out. Rotating AUTH_SECRET signs everyone out at once.

export interface AuthConfig {
  /** Public base URL of this server, e.g. https://rent-manager-mcp.onrender.com */
  publicUrl: URL;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Google Workspace domains whose users may sign in, e.g. ["cornellcommunities.com"]. */
  allowedDomains: string[];
  /** Individual addresses allowed in addition to the domains. */
  allowedEmails: string[];
  /** Addresses that also get the write tools. Everyone else is read-only. */
  editorEmails: string[];
  /** Hosts besides claude.ai / claude.com that may receive sign-in codes. */
  extraRedirectHosts: string[];
}

const CLAUDE_REDIRECT_HOSTS = ["claude.ai", "claude.com"];

/**
 * Anyone can register a client, so without this check an attacker could
 * register their own website as the callback and phish a team member's
 * sign-in. Only Claude's callbacks and loopback addresses (Claude Code
 * and other local clients) are accepted.
 */
export function isAllowedRedirect(uri: string, extraHosts: string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:") return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  return url.protocol === "https:" && [...CLAUDE_REDIRECT_HOSTS, ...extraHosts].includes(host);
}

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;
const CODE_SECONDS = 5 * 60;

export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ── Sealing ──

type Purpose = "login" | "code" | "access" | "refresh";

export class Sealer {
  private readonly key: Buffer;
  private readonly macKey: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");
    this.key = Buffer.from(hkdfSync("sha256", secret, "rent-manager-mcp", "seal-v1", 32));
    this.macKey = Buffer.from(hkdfSync("sha256", secret, "rent-manager-mcp", "mac-v1", 32));
  }

  /** Short keyed signature, for values that must stay compact (client IDs, client secrets). */
  mac(purpose: string, value: string, length = 22): string {
    return createHmac("sha256", this.macKey).update(`${purpose}:${value}`).digest("base64url").slice(0, length);
  }

  macMatches(purpose: string, value: string, tag: string, length = 22): boolean {
    const expected = Buffer.from(this.mac(purpose, value, length));
    const given = Buffer.from(tag);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  seal(purpose: Purpose, payload: object, ttlSeconds?: number): string {
    const body = ttlSeconds ? { ...payload, exp: now() + ttlSeconds } : payload;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const data = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  /** Returns the payload, or undefined if the blob was forged, made for another purpose, or expired. */
  unseal<T extends object>(purpose: Purpose, sealed: string): (T & { exp?: number }) | undefined {
    try {
      const raw = Buffer.from(sealed, "base64url");
      if (raw.length < 29) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      const payload = JSON.parse(text) as T & { exp?: number };
      if (payload.exp !== undefined && payload.exp < now()) return undefined;
      return payload;
    } catch {
      return undefined;
    }
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Access policy ──

export interface UserIdentity {
  email: string;
  name?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAllowed(config: AuthConfig, email: string, hostedDomain?: string): boolean {
  const e = normalizeEmail(email);
  if (config.allowedEmails.includes(e) || config.editorEmails.includes(e)) return true;
  const domain = (hostedDomain ?? e.split("@")[1] ?? "").toLowerCase();
  return config.allowedDomains.includes(domain);
}

export function isEditor(config: AuthConfig, email: string): boolean {
  return config.editorEmails.includes(normalizeEmail(email));
}

// ── Payloads ──

/** What a client ID carries: redirect URIs, public (1) or confidential (0), issued-at. */
interface CompactClient {
  r: string[];
  p: 0 | 1;
  t: number;
}

interface LoginState {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes?: string[];
  resource?: string;
}

interface CodePayload extends LoginState, UserIdentity {
  nonce: string;
}

interface TokenPayload extends UserIdentity {
  clientId: string;
  scopes?: string[];
  resource?: string;
}

// ── Provider ──

export class GoogleOAuthProvider implements OAuthServerProvider {
  readonly sealer: Sealer;
  /** Codes already exchanged, kept until they expire so each works once. */
  private readonly usedCodes = new Map<string, number>();

  constructor(
    readonly config: AuthConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {
    this.sealer = new Sealer(config.secret);
  }

  get googleRedirectUri(): string {
    return new URL(GOOGLE_CALLBACK_PATH, this.config.publicUrl).href;
  }

  /**
   * Dynamic client registration without a database. The client ID is a short
   * signed record of the redirect URIs and whether the client is public:
   * "<base64url JSON>.<signature>", about 130 characters for Claude. Other
   * metadata (name, logo) isn't kept because nothing here uses it. A
   * confidential client's secret is derived from its ID, so it needn't be
   * stored either.
   */
  get clientsStore(): OAuthRegisteredClientsStore {
    const describe = (clientId: string, record: CompactClient): OAuthClientInformationFull => {
      const isPublic = record.p === 1;
      return {
        client_id: clientId,
        client_id_issued_at: record.t,
        redirect_uris: record.r,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: isPublic ? "none" : "client_secret_post",
        ...(isPublic ? {} : { client_secret: this.sealer.mac("client-secret", clientId, 43), client_secret_expires_at: 0 }),
      };
    };
    return {
      getClient: (clientId: string) => {
        const [body, tag] = clientId.split(".");
        if (!body || !tag || !this.sealer.macMatches("client", body, tag)) return undefined;
        try {
          const record = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CompactClient;
          return Array.isArray(record.r) ? describe(clientId, record) : undefined;
        } catch {
          return undefined;
        }
      },
      registerClient: (client) => {
        const bad = client.redirect_uris.filter((u) => !isAllowedRedirect(String(u), this.config.extraRedirectHosts));
        if (bad.length) {
          console.error(`[auth] refused client registration with redirect ${bad.join(", ")}`);
          throw new InvalidClientMetadataError(
            `Redirect URI not allowed: ${bad.join(", ")}. Only Claude's callback addresses are accepted (set EXTRA_REDIRECT_HOSTS to add one).`
          );
        }
        const record: CompactClient = {
          r: client.redirect_uris.map(String),
          p: client.token_endpoint_auth_method === "none" ? 1 : 0,
          t: now(),
        };
        const body = Buffer.from(JSON.stringify(record)).toString("base64url");
        const clientId = `${body}.${this.sealer.mac("client", body)}`;
        const registered = describe(clientId, record);
        console.error(`[auth] registered ${record.p ? "public" : "confidential"} client "${client.client_name ?? "unnamed"}" for ${record.r.join(", ")}`);
        // Echo the requested name back so the client sees what it registered.
        return { ...registered, ...(client.client_name ? { client_name: client.client_name } : {}) };
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const login: LoginState = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes,
      resource: params.resource?.href,
    };
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: this.googleRedirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: this.sealer.seal("login", login, LOGIN_SECONDS),
      prompt: "select_account",
      ...(this.config.allowedDomains.length === 1 ? { hd: this.config.allowedDomains[0] } : {}),
    }).toString();
    res.redirect(302, url.href);
  }

  /**
   * Handles Google's redirect back to us. Returns where to send the browser,
   * or an error message to show the person.
   */
  async completeGoogleLogin(query: Record<string, unknown>): Promise<{ redirect: string } | { status: number; message: string }> {
    const login = typeof query.state === "string" ? this.sealer.unseal<LoginState>("login", query.state) : undefined;
    if (!login) return { status: 400, message: "This sign-in link has expired. Go back to Claude and try connecting again." };

    const back = (params: Record<string, string>) => {
      const url = new URL(login.redirectUri);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (login.state) url.searchParams.set("state", login.state);
      return { redirect: url.href };
    };

    if (typeof query.error === "string") return back({ error: "access_denied", error_description: `Google sign-in failed: ${query.error}` });
    if (typeof query.code !== "string") return { status: 400, message: "Google did not return a sign-in code." };

    let identity: UserIdentity & { hd?: string };
    try {
      identity = await this.exchangeGoogleCode(query.code);
    } catch (err) {
      console.error(`[auth] Google sign-in failed: ${err instanceof Error ? err.message : err}`);
      return { status: 502, message: "Google sign-in could not be completed. Try again in a minute." };
    }

    if (!isAllowed(this.config, identity.email, identity.hd)) {
      console.error(`[auth] refused sign-in for ${identity.email}`);
      return {
        status: 403,
        message: `${identity.email} is not allowed to use this connector. Sign in with your company Google account, or ask the administrator to add you.`,
      };
    }

    console.error(`[auth] signed in ${identity.email}${isEditor(this.config, identity.email) ? " (editor)" : ""}`);
    const code = this.sealer.seal(
      "code",
      { ...login, email: normalizeEmail(identity.email), name: identity.name, nonce: randomBytes(8).toString("hex") } satisfies CodePayload,
      CODE_SECONDS
    );
    return back({ code });
  }

  /**
   * Trades Google's code for an ID token. The token comes straight from
   * Google's token endpoint over TLS, authenticated with our client secret,
   * which OpenID Connect accepts in place of checking its signature.
   */
  private async exchangeGoogleCode(code: string): Promise<UserIdentity & { hd?: string }> {
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        redirect_uri: this.googleRedirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.id_token) throw new Error(`token endpoint returned ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim());

    const claims = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      iss?: string;
      aud?: string;
      exp?: number;
      email?: string;
      email_verified?: boolean;
      name?: string;
      hd?: string;
    };
    if (claims.aud !== this.config.googleClientId) throw new Error("ID token audience mismatch");
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("ID token issuer mismatch");
    if (!claims.exp || claims.exp < now()) throw new Error("ID token expired");
    if (!claims.email || claims.email_verified !== true) throw new Error("Google account has no verified email");
    return { email: claims.email, name: claims.name, hd: claims.hd };
  }

  private readCode(client: OAuthClientInformationFull, code: string): CodePayload & { exp?: number } {
    const payload = this.sealer.unseal<CodePayload>("code", code);
    if (!payload || payload.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return payload;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.readCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const payload = this.readCode(client, code);
    if (redirectUri && redirectUri !== payload.redirectUri) throw new InvalidGrantError("redirect_uri does not match");

    const t = now();
    for (const [key, exp] of this.usedCodes) if (exp < t) this.usedCodes.delete(key);
    const key = createHash("sha256").update(code).digest("hex");
    if (this.usedCodes.has(key)) throw new InvalidGrantError("Authorization code already used");
    this.usedCodes.set(key, payload.exp ?? t + CODE_SECONDS);

    if (!isAllowed(this.config, payload.email)) throw new InvalidGrantError("Access has been removed for this account");
    return this.issueTokens({ email: payload.email, name: payload.name, clientId: client.client_id, scopes: payload.scopes, resource: payload.resource });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const payload = this.sealer.unseal<TokenPayload>("refresh", refreshToken);
    if (!payload || payload.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
    if (!isAllowed(this.config, payload.email)) throw new InvalidGrantError("Access has been removed for this account");
    return this.issueTokens(payload);
  }

  private issueTokens(user: TokenPayload): OAuthTokens {
    const payload: TokenPayload = { email: user.email, name: user.name, clientId: user.clientId, scopes: user.scopes, resource: user.resource };
    return {
      access_token: this.sealer.seal("access", payload, ACCESS_TOKEN_SECONDS),
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: this.sealer.seal("refresh", payload, REFRESH_TOKEN_SECONDS),
      ...(user.scopes?.length ? { scope: user.scopes.join(" ") } : {}),
    };
  }

  /** Checked on every MCP request, so removing someone from the allow list takes effect immediately. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = this.sealer.unseal<TokenPayload>("access", token);
    if (!payload) throw new InvalidTokenError("Invalid or expired access token");
    if (!isAllowed(this.config, payload.email)) throw new InvalidTokenError("Access has been removed for this account");
    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scopes ?? [],
      expiresAt: payload.exp,
      ...(payload.resource ? { resource: new URL(payload.resource) } : {}),
      extra: { email: payload.email, name: payload.name },
    };
  }
}
