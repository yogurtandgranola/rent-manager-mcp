import type { RentManagerConfig } from "./types.js";

// ── Errors ──

export class RentManagerError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(status: number, message: string, endpoint: string) {
    super(message);
    this.name = "RentManagerError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

// ── Query building ──

export interface QueryOptions {
  /** RQL filter clauses, e.g. rql.eq("PropertyID", 3). Joined with ";". */
  filters?: string[];
  fields?: string[];
  embed?: string[];
  /** e.g. ["TransactionDate DESC"] */
  orderby?: string[];
  pagesize?: number;
  pagenumber?: number;
  extra?: Record<string, string | number | boolean>;
}

/**
 * RQL uses "," to separate field/operator/value and ";" to separate clauses,
 * so those characters (and the parentheses used by "in") can't appear inside a
 * value. Replacing them with spaces keeps a search like "Smith, John" from
 * breaking the whole query.
 */
export function rqlValue(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  return value.replace(/[,;()]/g, " ").replace(/\s+/g, " ").trim();
}

export const rql = {
  eq: (field: string, value: string | number | boolean) => `${field},eq,${rqlValue(value)}`,
  ne: (field: string, value: string | number | boolean) => `${field},ne,${rqlValue(value)}`,
  ct: (field: string, value: string) => `${field},ct,${rqlValue(value)}`,
  sw: (field: string, value: string) => `${field},sw,${rqlValue(value)}`,
  gt: (field: string, value: string | number) => `${field},gt,${rqlValue(value)}`,
  ge: (field: string, value: string | number) => `${field},ge,${rqlValue(value)}`,
  lt: (field: string, value: string | number) => `${field},lt,${rqlValue(value)}`,
  le: (field: string, value: string | number) => `${field},le,${rqlValue(value)}`,
  in: (field: string, values: Array<string | number>) =>
    `${field},in,(${values.map(rqlValue).join(",")})`,
};

function toSearchParams(query: QueryOptions = {}): URLSearchParams {
  const params = new URLSearchParams();
  if (query.filters?.length) params.set("filters", query.filters.join(";"));
  if (query.fields?.length) params.set("fields", query.fields.join(","));
  // Instances differ on the parameter name (the one this was built against
  // ignores "embed" and reads "embeds"); unknown parameters are ignored, so send both.
  if (query.embed?.length) {
    params.set("embed", query.embed.join(","));
    params.set("embeds", query.embed.join(","));
  }
  if (query.orderby?.length) params.set("orderby", query.orderby.join(","));
  if (query.pagesize !== undefined) params.set("pagesize", String(query.pagesize));
  if (query.pagenumber !== undefined) params.set("pagenumber", String(query.pagenumber));
  for (const [key, value] of Object.entries(query.extra ?? {})) params.set(key, String(value));
  return params;
}

// ── Client ──

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 50;

interface RawResponse {
  data: unknown;
  headers: Headers;
}

interface RequestOptions {
  query?: QueryOptions;
  body?: unknown;
}

export class RentManagerClient {
  private readonly config: RentManagerConfig;
  private readonly fetchImpl: typeof fetch;
  private token: string | null;
  private authInFlight: Promise<string> | null = null;
  /** Retry delay base in ms. Exposed so tests can turn backoff off. */
  retryDelayMs = 500;

  constructor(config: RentManagerConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.token = config.apiToken ?? null;
  }

  private get canAuthenticate(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  /**
   * POST /Authentication/AuthorizeUser. Rent Manager answers with the token as
   * a bare JSON string, which is then sent on every request in the
   * X-RM12Api-ApiToken header. Concurrent callers share one login.
   */
  async authenticate(): Promise<string> {
    if (!this.canAuthenticate) {
      throw new RentManagerError(
        401,
        "No usable credentials. Set RM_USERNAME and RM_PASSWORD (or a valid RM_API_TOKEN).",
        "/Authentication/AuthorizeUser"
      );
    }
    this.authInFlight ??= this.login().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async login(): Promise<string> {
    const endpoint = "/Authentication/AuthorizeUser";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          Username: this.config.username,
          Password: this.config.password,
          LocationID: this.config.locationId,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw new RentManagerError(0, `Could not reach Rent Manager at ${this.config.baseUrl}: ${describe(err)}`, endpoint);
    }

    const data = await readBody(res);
    if (isHtml(data)) throw htmlError(res.status, endpoint);
    if (!res.ok) {
      throw new RentManagerError(
        res.status,
        `Authentication failed (check RM_USERNAME, RM_PASSWORD and RM_LOCATION_ID): ${errorDetail(res, data)}`,
        endpoint
      );
    }

    const token =
      typeof data === "string"
        ? data
        : typeof data === "object" && data !== null
          ? ((data as Record<string, unknown>).Token ?? (data as Record<string, unknown>).token)
          : undefined;
    if (typeof token !== "string" || !token.trim()) {
      throw new RentManagerError(res.status, "Authentication succeeded but no token was returned.", endpoint);
    }
    this.token = token.trim();
    return this.token;
  }

  private async send(method: string, path: string, opts: RequestOptions): Promise<Response> {
    if (!this.token) await this.authenticate();
    const qs = toSearchParams(opts.query).toString();
    const url = `${this.config.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-RM12Api-ApiToken": this.token ?? "",
      },
      signal: AbortSignal.timeout(this.config.timeoutMs),
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return this.fetchImpl(url, init);
  }

  /**
   * Sends one request with these rules:
   * - 401: log in again once and retry (only possible with username/password).
   * - GET only: retry network errors, timeouts, 429 and 5xx with backoff.
   *   Writes are never retried, so a note or work order can't be created twice.
   * - GET with fields/embed that returns 400: retry once without them, since an
   *   older Rent Manager version may not know a field we asked for.
   */
  private async requestRaw(method: string, path: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const idempotent = method === "GET";
    let reauthed = false;
    let strippedQuery = false;
    let attempt = 0;

    for (;;) {
      let res: Response;
      try {
        res = await this.send(method, path, opts);
      } catch (err) {
        if (err instanceof RentManagerError) throw err;
        if (idempotent && attempt < MAX_RETRIES) {
          await sleep(this.retryDelayMs * 2 ** attempt++);
          continue;
        }
        throw new RentManagerError(0, `Network error calling Rent Manager: ${describe(err)}`, path);
      }

      if (res.status === 401 && !reauthed && this.canAuthenticate) {
        reauthed = true;
        await res.body?.cancel().catch(() => {});
        this.token = null;
        await this.authenticate();
        continue;
      }

      if (idempotent && RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await res.body?.cancel().catch(() => {});
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.retryDelayMs * 2 ** attempt;
        attempt++;
        await sleep(Math.min(delay, 10_000));
        continue;
      }

      const data = await readBody(res);
      if (isHtml(data)) throw htmlError(res.status, path);

      if (res.status === 400 && idempotent && !strippedQuery && (opts.query?.fields?.length || opts.query?.embed?.length)) {
        strippedQuery = true;
        opts = { ...opts, query: { ...opts.query, fields: undefined, embed: undefined } };
        continue;
      }

      if (!res.ok) {
        const hint =
          res.status === 401
            ? " The API token was rejected; set RM_USERNAME/RM_PASSWORD so the server can log in again."
            : res.status === 403
              ? " The API user lacks permission for this resource."
              : "";
        throw new RentManagerError(res.status, `${errorDetail(res, data)}${hint}`, path);
      }
      return { data, headers: res.headers };
    }
  }

  async get<T>(path: string, query?: QueryOptions): Promise<T> {
    return (await this.requestRaw("GET", path, { query })).data as T;
  }

  async post<T>(path: string, body: unknown, query?: QueryOptions): Promise<T> {
    return (await this.requestRaw("POST", path, { body, query })).data as T;
  }

  /**
   * Fetches every page of a collection. Stops when a page comes back short,
   * when the Link header has no rel="next", or when X-Total-Results is reached.
   */
  async getAll<T>(path: string, query: QueryOptions = {}, maxPages = DEFAULT_MAX_PAGES): Promise<T[]> {
    const pagesize = query.pagesize ?? DEFAULT_PAGE_SIZE;
    const rows: T[] = [];
    for (let pagenumber = 1; pagenumber <= maxPages; pagenumber++) {
      const { data, headers } = await this.requestRaw("GET", path, { query: { ...query, pagesize, pagenumber } });
      const page = Array.isArray(data) ? (data as T[]) : data == null || data === "" ? [] : [data as T];
      rows.push(...page);

      const total = Number.parseInt(headers.get("x-total-results") ?? "", 10);
      const link = headers.get("link");
      if (page.length < pagesize) break;
      if (Number.isFinite(total) && rows.length >= total) break;
      if (link !== null && !/rel="?next"?/i.test(link)) break;
      if (pagenumber === maxPages) {
        console.error(`[rent-manager] ${path}: stopped after ${maxPages} pages (${rows.length} rows); results may be incomplete.`);
      }
    }
    return rows;
  }
}

// ── Helpers ──

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isHtml(data: unknown): boolean {
  return typeof data === "string" && /^\s*</.test(data);
}

/** A web page instead of JSON almost always means the base URL points at the Rent Manager web app, not the API. */
function htmlError(status: number, endpoint: string): RentManagerError {
  return new RentManagerError(
    status,
    "Rent Manager returned a web page instead of API data. Check RM_CORP_ID / RM_API_BASE_URL: the API lives at https://{corpid}.api.rentmanager.com.",
    endpoint
  );
}

/** Rent Manager error bodies usually carry DeveloperMessage / UserMessage. */
function errorDetail(res: Response, data: unknown): string {
  let detail = "";
  if (typeof data === "object" && data !== null) {
    const body = data as Record<string, unknown>;
    detail = [body.UserMessage, body.DeveloperMessage, body.Message, body.message]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .filter((v, i, all) => all.indexOf(v) === i)
      .join(" | ");
    if (!detail) detail = JSON.stringify(data);
  } else if (typeof data === "string") {
    detail = data;
  }
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  return detail ? `${status}: ${detail.slice(0, 500)}` : status;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "request timed out";
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
