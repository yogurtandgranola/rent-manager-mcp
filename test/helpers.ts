import { RentManagerClient } from "../src/rent-manager-client.js";
import { RentManagerService } from "../src/services.js";
import type { RentManagerConfig } from "../src/types.js";

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: MockRequest) => MockResponse | undefined;

export const BASE_URL = "https://acme.api.rentmanager.com";

export function testConfig(overrides: Partial<RentManagerConfig> = {}): RentManagerConfig {
  return {
    baseUrl: BASE_URL,
    username: "api-user",
    password: "secret",
    locationId: 1,
    readOnly: false,
    timeoutMs: 5000,
    ...overrides,
  };
}

/**
 * A fake Rent Manager. Login is handled automatically unless the handler
 * answers /Authentication/AuthorizeUser itself; anything unanswered is a 404.
 */
export function mockFetch(handler: Handler) {
  const calls: MockRequest[] = [];
  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const req: MockRequest = {
      method: (init.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {})),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    let res = handler(req);
    if (!res && req.path === "/Authentication/AuthorizeUser") res = { body: "token-1" };
    if (!res) res = { status: 404, body: { UserMessage: `No route ${req.method} ${req.path}` } };
    const status = res.status ?? 200;
    const payload = res.body === undefined ? null : JSON.stringify(res.body);
    return new Response(status === 204 ? null : payload, {
      status,
      headers: { "content-type": "application/json", ...(res.headers ?? {}) },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

export function makeService(handler: Handler, config: Partial<RentManagerConfig> = {}, today = "2026-10-26") {
  const mock = mockFetch(handler);
  const cfg = testConfig(config);
  const client = new RentManagerClient(cfg, mock.fetch);
  client.retryDelayMs = 0;
  const service = new RentManagerService(client, cfg, () => new Date(`${today}T12:00:00`));
  return { service, client, calls: mock.calls };
}

/** Returns body for a GET to `path`, or undefined. */
export function route(req: MockRequest, method: string, path: string, body: unknown): MockResponse | undefined {
  return req.method === method && req.path === path ? { body } : undefined;
}
