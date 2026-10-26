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
  // Render and similar hosts sit behind one proxy; rate limiting needs the real client IP.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "Rent Manager",
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
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
