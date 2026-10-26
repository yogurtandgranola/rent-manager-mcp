#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleOAuthProvider } from "./auth.js";
import { loadAuthConfig, loadConfig } from "./config.js";
import { createHttpApp, MCP_PATH } from "./http.js";
import { RentManagerClient } from "./rent-manager-client.js";
import { RentManagerService } from "./services.js";
import { registerTools } from "./tools.js";

const VERSION = "2.1.1";

// Load .env from the project root (one level above src/ or dist/). Variables
// already set in the environment, e.g. from claude_desktop_config.json, win.
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const httpMode = process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http";

function fail(err: unknown): never {
  console.error(`[rent-manager] Configuration error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail(err);
  }
  const service = new RentManagerService(new RentManagerClient(config), config);

  if (httpMode) {
    let authConfig;
    try {
      authConfig = loadAuthConfig();
    } catch (err) {
      fail(err);
    }
    const app = createHttpApp(service, new GoogleOAuthProvider(authConfig), VERSION);
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => {
      const editors = authConfig.editorEmails.join(", ") || "none";
      console.error(
        `[rent-manager] Hosted MCP server v${VERSION} on port ${port}. Connector URL: ${new URL(MCP_PATH, authConfig.publicUrl).href} ` +
          `(domains: ${authConfig.allowedDomains.join(", ") || "none"}; editors: ${editors}${config.readOnly ? "; RM_READ_ONLY on" : ""})`
      );
    });
    return;
  }

  const server = new McpServer({ name: "rent-manager", version: VERSION });
  registerTools(server, service, { allowWrites: !config.readOnly });
  await server.connect(new StdioServerTransport());
  console.error(`[rent-manager] MCP server v${VERSION} running on stdio (${config.baseUrl}${config.readOnly ? ", read-only" : ""})`);
}

main().catch((err) => {
  console.error("[rent-manager] Fatal error:", err);
  process.exit(1);
});
