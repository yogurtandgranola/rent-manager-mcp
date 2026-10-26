import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { GOOGLE_CALLBACK_PATH, GoogleOAuthProvider, isEditor } from "./auth.js";
import type { RentManagerService } from "./services.js";
import { registerTools } from "./tools.js";

export const MCP_PATH = "/mcp";

function page(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#222}</style>
</head><body><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`;
}

/**
 * The hosted server: Claude custom connector endpoint at /mcp, protected by
 * OAuth, with Google as the identity provider. Each request gets its own
 * stateless MCP server whose tools depend on who signed in.
 */
export function createHttpApp(service: RentManagerService, provider: GoogleOAuthProvider, version: string): express.Express {
  const { config } = provider;
  const mcpUrl = new URL(MCP_PATH, config.publicUrl);
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  // One line per sign-in step and MCP call, so a failed connection can be
  // traced in the host's logs. OAuth error codes are logged; secrets never are.
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    let detail = "";
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 400 && body && typeof body === "object") {
        const { error, error_description } = body as { error?: unknown; error_description?: unknown };
        if (error) detail = ` ${String(error)}${error_description ? `: ${String(error_description).slice(0, 300)}` : ""}`;
      }
      return json(body);
    };
    // originalUrl, because routers mounted by the SDK rewrite req.path; the query string may hold codes, so drop it.
    const path = req.originalUrl.split("?")[0];
    res.on("finish", () => console.error(`[http] ${req.method} ${path} -> ${res.statusCode}${detail} (from ${req.ip})`));
    next();
  });

  // RFC 6749 lets clients send their secret as HTTP Basic auth; the SDK's
  // token endpoint only reads it from the form body, so copy it there.
  app.use(["/token", "/revoke"], express.urlencoded({ extended: false }), (req, _res, next) => {
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Basic ") && req.body && typeof req.body === "object" && !req.body.client_id) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const split = decoded.indexOf(":");
      if (split > 0) {
        req.body.client_id = decodeURIComponent(decoded.slice(0, split));
        req.body.client_secret = decodeURIComponent(decoded.slice(split + 1));
      }
    }
    next();
  });

  app.get("/health", (_req, res) => {
    // Shows the exact URLs to paste into Claude and Google, so nobody copies an example address.
    res.json({
      ok: true,
      version,
      connectorUrl: mcpUrl.href,
      googleRedirectUri: provider.googleRedirectUri,
    });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "Rent Manager",
      // Registration is stateless and cheap, and every Claude user arrives from
      // Anthropic's few egress IPs (often seen as one proxy IP), so a
      // per-IP limit would lock the whole team out after a handful of connects.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: false },
      authorizationOptions: { rateLimit: { windowMs: 15 * 60_000, max: 500, validate: { trustProxy: false } } },
      tokenOptions: { rateLimit: { windowMs: 15 * 60_000, max: 1000, validate: { trustProxy: false } } },
    })
  );

  app.get(GOOGLE_CALLBACK_PATH, async (req: Request, res: Response) => {
    const result = await provider.completeGoogleLogin(req.query as Record<string, unknown>);
    if ("redirect" in result) return res.redirect(302, result.redirect);
    res.status(result.status).type("html").send(page("Can't sign you in", result.message));
  });

  app.get("/", (_req, res) => {
    res
      .type("html")
      .send(page("Rent Manager connector", `This server is a Claude connector. In Claude, add a custom connector with the URL ${mcpUrl.href}`));
  });

  const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

  app.post(MCP_PATH, auth, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    const email = String(req.auth?.extra?.email ?? "");
    const allowWrites = !service.config.readOnly && isEditor(config, email);

    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    if (body?.method === "tools/call") console.error(`[mcp] ${email} called ${body.params?.name}`);

    const server = new McpServer({ name: "rent-manager", version });
    registerTools(server, service, { allowWrites, userEmail: email });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless server: no server-initiated streams or sessions to delete.
  app.all(MCP_PATH, auth, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return app;
}
