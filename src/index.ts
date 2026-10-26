#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { RentManagerClient } from "./rent-manager-client.js";
import { RentManagerService } from "./services.js";
import { registerTools } from "./tools.js";

const VERSION = "2.0.0";

// Load .env from the project root (one level above src/ or dist/). Variables
// already set in the environment, e.g. from claude_desktop_config.json, win.
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[rent-manager] Configuration error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const service = new RentManagerService(new RentManagerClient(config), config);
  const server = new McpServer({ name: "rent-manager", version: VERSION });
  registerTools(server, service);

  await server.connect(new StdioServerTransport());
  console.error(`[rent-manager] MCP server v${VERSION} running on stdio (${config.baseUrl}${config.readOnly ? ", read-only" : ""})`);
}

main().catch((err) => {
  console.error("[rent-manager] Fatal error:", err);
  process.exit(1);
});
