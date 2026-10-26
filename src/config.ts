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
