import type { AuthConfig } from "./auth.js";
import type { RentManagerConfig } from "./types.js";

function flag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function optionalInt(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number (got "${raw}").`);
  return n;
}

/**
 * Reads configuration from the environment. The API lives at
 * https://{corpid}.api.rentmanager.com, so RM_CORP_ID alone is enough;
 * RM_API_BASE_URL overrides it for non-standard hosts.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RentManagerConfig {
  const corpId = env.RM_CORP_ID?.trim();
  const baseUrl = env.RM_API_BASE_URL?.trim() || (corpId ? `https://${corpId}.api.rentmanager.com` : "");
  if (!baseUrl) {
    throw new Error("Set RM_CORP_ID (your Rent Manager corporate ID) or RM_API_BASE_URL. See .env.example.");
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`RM_API_BASE_URL must start with https:// (got "${baseUrl}").`);
  }

  const username = env.RM_USERNAME?.trim() || undefined;
  const password = env.RM_PASSWORD || undefined;
  const apiToken = env.RM_API_TOKEN?.trim() || undefined;
  if (!apiToken && !(username && password)) {
    throw new Error("Set RM_USERNAME and RM_PASSWORD for your Rent Manager API user (or RM_API_TOKEN).");
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    username,
    password,
    apiToken,
    locationId: optionalInt("RM_LOCATION_ID", env) ?? 1,
    readOnly: flag(env.RM_READ_ONLY),
    timeoutMs: (optionalInt("RM_TIMEOUT_SECONDS", env) ?? 30) * 1000,
    noteCategoryId: optionalInt("RM_NOTE_CATEGORY_ID", env),
  };
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,;]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when running the hosted (--http) server. See docs/TEAM_SETUP.md.`);
  return value;
}

/**
 * Google credentials pasted into a hosting dashboard often pick up line
 * breaks or spaces, and Google then answers "OAuth client was not found"
 * with no hint why. Whitespace is never valid in either value, so strip it,
 * then check the client ID's shape so a mangled value fails at startup.
 */
function googleCredential(name: string, env: NodeJS.ProcessEnv): string {
  const value = required(name, env).replace(/\s+/g, "");
  if (name === "GOOGLE_CLIENT_ID" && !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(value)) {
    throw new Error(
      `GOOGLE_CLIENT_ID doesn't look like a Google OAuth client ID (got "${value}"). ` +
        "Copy it again with the copy button in Google Cloud > Google Auth Platform > Clients; it should look like 1234567890-abc123.apps.googleusercontent.com."
    );
  }
  return value;
}

/** Settings for the hosted server's Google sign-in. Fails closed: someone must be allowed in. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  // Render sets RENDER_EXTERNAL_URL automatically.
  const rawUrl = env.PUBLIC_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim();
  if (!rawUrl) throw new Error("PUBLIC_URL is required when running the hosted (--http) server, e.g. https://rent-manager-mcp-ab12.onrender.com");
  const publicUrl = new URL(rawUrl);
  const isLocal = ["localhost", "127.0.0.1"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !isLocal) throw new Error("PUBLIC_URL must use https://");

  const allowedDomains = list(env.ALLOWED_DOMAINS).map((d) => d.replace(/^@/, ""));
  const allowedEmails = list(env.ALLOWED_EMAILS);
  const editorEmails = list(env.EDITOR_EMAILS);
  if (!allowedDomains.length && !allowedEmails.length && !editorEmails.length) {
    throw new Error("Set ALLOWED_DOMAINS (your Google Workspace domain) and/or ALLOWED_EMAILS so someone can sign in.");
  }
  const secret = required("AUTH_SECRET", env);
  if (secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");

  return {
    publicUrl,
    secret,
    googleClientId: googleCredential("GOOGLE_CLIENT_ID", env),
    googleClientSecret: googleCredential("GOOGLE_CLIENT_SECRET", env),
    allowedDomains,
    allowedEmails,
    editorEmails,
    extraRedirectHosts: list(env.EXTRA_REDIRECT_HOSTS),
  };
}
