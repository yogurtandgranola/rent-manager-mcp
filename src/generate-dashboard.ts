#!/usr/bin/env node

/**
 * Standalone dashboard generator — no MCP client needed, so anyone on the team
 * (or a cron job) can produce a fresh dashboard:
 *
 *   npm run dashboard                       # full portfolio, live data
 *   npm run dashboard -- --property "Oak Park"
 *   npm run dashboard -- --out reports/weekly.html
 *   npm run dashboard -- --demo             # sample data, no credentials needed
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "./env.js";
import { RentManagerClient } from "./rent-manager-client.js";
import { renderDashboardHTML } from "./dashboard.js";
import { demoSnapshot } from "./demo-data.js";
import type { PortfolioSnapshot } from "./types.js";

function parseArgs(argv: string[]): { demo: boolean; out?: string; property?: string } {
  const args: { demo: boolean; out?: string; property?: string } = { demo: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--demo":
        args.demo = true;
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--property":
        args.property = argv[++i];
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: generate-dashboard [--demo] [--property <name>] [--out <file.html>]"
        );
        process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let snapshot: PortfolioSnapshot;
  let scopeLabel: string | undefined;

  if (args.demo) {
    snapshot = demoSnapshot();
    scopeLabel = "Demo Data";
  } else {
    loadDotEnv();
    const baseUrl = process.env.RM_API_BASE_URL;
    if (!baseUrl) {
      console.error(
        "ERROR: RM_API_BASE_URL is not set. Configure .env (see .env.example) or run with --demo."
      );
      process.exit(1);
    }

    const client = new RentManagerClient({
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiToken: process.env.RM_API_TOKEN,
      username: process.env.RM_USERNAME,
      password: process.env.RM_PASSWORD,
      locationId: process.env.RM_LOCATION_ID || "1",
    });

    let propertyId: number | undefined;
    if (args.property) {
      const property = await client.findPropertyByName(args.property);
      if (!property) {
        console.error(`ERROR: No property found matching "${args.property}".`);
        process.exit(1);
      }
      propertyId = property.PropertyID;
      scopeLabel = property.Name;
    }

    console.error("Pulling data from Rent Manager…");
    snapshot = await client.getPortfolioSnapshot(propertyId);
  }

  const html = renderDashboardHTML(snapshot, scopeLabel);
  const date = new Date().toISOString().slice(0, 10);
  const outPath = resolve(args.out ?? `rent-dashboard-${date}.html`);
  writeFileSync(outPath, html, "utf8");
  console.log(outPath);
}

main().catch((err) => {
  console.error("Failed to generate dashboard:", err);
  process.exit(1);
});
