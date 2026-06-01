#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RentManagerClient } from "./rent-manager-client.js";
import type { RentManagerConfig, ApiError } from "./types.js";

// ── Configuration ──

function loadConfig(): RentManagerConfig {
  const baseUrl = process.env.RM_API_BASE_URL;
  if (!baseUrl) {
    console.error(
      "ERROR: RM_API_BASE_URL is required. Set it in your environment or .env file.\n" +
        "See .env.example for all configuration options."
    );
    process.exit(1);
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""), // strip trailing slashes
    apiToken: process.env.RM_API_TOKEN,
    username: process.env.RM_USERNAME,
    password: process.env.RM_PASSWORD,
    locationId: process.env.RM_LOCATION_ID || "1",
  };
}

// ── Formatting Helpers ──

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function formatError(err: unknown): string {
  if (typeof err === "object" && err !== null && "status" in err) {
    const apiErr = err as ApiError;
    return `❌ API Error (${apiErr.status}): ${apiErr.message}\n   Endpoint: ${apiErr.endpoint}`;
  }
  if (err instanceof Error) {
    return `❌ Error: ${err.message}`;
  }
  return `❌ Unexpected error: ${String(err)}`;
}

// ── Server Setup ──

const config = loadConfig();
const client = new RentManagerClient(config);

const server = new McpServer({
  name: "rent-manager",
  version: "1.0.0",
});

// ── Tool 1: Get Delinquencies ──

server.tool(
  "get_delinquencies",
  "Pull delinquency data for a property. Shows tenants with outstanding balances, sorted by amount owed. You can search by property name (e.g. 'Sunflower Estates').",
  {
    property_name: z.string().optional().describe("Property name to filter by (partial match supported). Omit to get all properties."),
  },
  async ({ property_name }) => {
    try {
      let propertyId: number | undefined;

      if (property_name) {
        const property = await client.findPropertyByName(property_name);
        if (!property) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No property found matching "${property_name}". Try a different name or omit the property to see all delinquencies.`,
              },
            ],
          };
        }
        propertyId = property.PropertyID;
      }

      const records = await client.getDelinquencies(propertyId);

      if (records.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: property_name
                ? `No delinquencies found at ${property_name}. 🎉`
                : "No delinquencies found across any properties.",
            },
          ],
        };
      }

      const totalOwed = records.reduce((sum, r) => sum + r.Balance, 0);

      let output = `## Delinquency Report${property_name ? ` — ${property_name}` : ""}\n\n`;
      output += `**${records.length} delinquent tenant(s)** | Total owed: **${formatCurrency(totalOwed)}**\n\n`;
      output += `| Tenant | Unit | Property | Balance | Days Past Due |\n`;
      output += `|--------|------|----------|---------|---------------|\n`;

      for (const r of records) {
        output += `| ${r.TenantName} | ${r.UnitName} | ${r.PropertyName} | ${formatCurrency(r.Balance)} | ${r.DaysPastDue || "N/A"} |\n`;
      }

      if (records[0]?.LastPaymentDate) {
        output += `\n### Last Payment Info\n`;
        for (const r of records.filter((r) => r.LastPaymentDate)) {
          output += `- **${r.TenantName}**: Last paid ${formatCurrency(r.LastPaymentAmount ?? 0)} on ${r.LastPaymentDate}\n`;
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
    }
  }
);

// ── Tool 2: Get Tenant Ledger ──

server.tool(
  "get_tenant_ledger",
  "Pull a tenant's ledger showing charges, payments, and credits. Search by tenant name or by property + unit number.",
  {
    tenant_name: z.string().optional().describe("Tenant name to search for (e.g. 'John Smith')"),
    property_name: z.string().optional().describe("Property name (used with unit_name to find the tenant)"),
    unit_name: z.string().optional().describe("Unit number/name (used with property_name to find the tenant)"),
  },
  async ({ tenant_name, property_name, unit_name }) => {
    try {
      let tenants;

      if (tenant_name) {
        tenants = await client.findTenantByName(tenant_name);
      } else if (property_name && unit_name) {
        tenants = await client.findTenantByUnit(property_name, unit_name);
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: "Please provide either a tenant_name OR both property_name and unit_name to look up the ledger.",
            },
          ],
        };
      }

      if (!tenants || tenants.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No tenant found matching your search. Try a different name or unit number.`,
            },
          ],
        };
      }

      // If multiple matches, show them for disambiguation
      if (tenants.length > 1) {
        let output = `Found ${tenants.length} tenants matching your search. Showing ledger for the first match.\n\n`;
        output += `**All matches:**\n`;
        for (const t of tenants) {
          output += `- ${t.FirstName} ${t.LastName} — Unit ${t.UnitName} at ${t.PropertyName} (ID: ${t.TenantID})\n`;
        }
        output += `\n---\n\n`;
      }

      const tenant = tenants[0];
      const ledger = await client.getTenantLedger(tenant.TenantID);

      let output = `## Ledger for ${tenant.FirstName} ${tenant.LastName}\n`;
      output += `**Unit:** ${tenant.UnitName} | **Property:** ${tenant.PropertyName} | **Current Balance:** ${formatCurrency(tenant.Balance)}\n\n`;

      if (ledger.length === 0) {
        output += `No ledger entries found.\n`;
      } else {
        output += `| Date | Description | Type | Amount | Balance |\n`;
        output += `|------|-------------|------|--------|----------|\n`;
        for (const item of ledger) {
          output += `| ${item.Date} | ${item.Description} | ${item.Type} | ${formatCurrency(item.Amount)} | ${formatCurrency(item.Balance)} |\n`;
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
    }
  }
);

// ── Tool 3: Add Tenant Note ──

server.tool(
  "add_tenant_note",
  "Write a note to a tenant's record in Rent Manager. Useful for logging call notes, maintenance requests, or other communications. Search by tenant name or property + unit.",
  {
    tenant_name: z.string().optional().describe("Tenant name to search for"),
    property_name: z.string().optional().describe("Property name (used with unit_name)"),
    unit_name: z.string().optional().describe("Unit number/name (used with property_name)"),
    note: z.string().describe("The note content to add to the tenant's record"),
  },
  async ({ tenant_name, property_name, unit_name, note }) => {
    try {
      let tenants;

      if (tenant_name) {
        tenants = await client.findTenantByName(tenant_name);
      } else if (property_name && unit_name) {
        tenants = await client.findTenantByUnit(property_name, unit_name);
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: "Please provide either a tenant_name OR both property_name and unit_name to identify the tenant.",
            },
          ],
        };
      }

      if (!tenants || tenants.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No tenant found matching your search. Note was NOT saved.`,
            },
          ],
        };
      }

      if (tenants.length > 1) {
        let output = `Found ${tenants.length} tenants matching your search. Please be more specific:\n\n`;
        for (const t of tenants) {
          output += `- ${t.FirstName} ${t.LastName} — Unit ${t.UnitName} at ${t.PropertyName} (ID: ${t.TenantID})\n`;
        }
        output += `\nNote was NOT saved. Narrow your search to a single tenant.`;
        return { content: [{ type: "text" as const, text: output }] };
      }

      const tenant = tenants[0];
      const result = await client.addTenantNote(tenant.TenantID, note);

      let output = `✅ Note added to **${tenant.FirstName} ${tenant.LastName}**'s record\n\n`;
      output += `- **Unit:** ${tenant.UnitName} at ${tenant.PropertyName}\n`;
      output += `- **Date:** ${result.Date}\n`;
      output += `- **Note ID:** ${result.NoteID}\n\n`;
      output += `> ${note.length > 200 ? note.substring(0, 200) + "..." : note}`;

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
    }
  }
);

// ── Tool 4: Get Rent Roll ──

server.tool(
  "get_rent_roll",
  "Pull the current rent roll for a property, showing all units with tenant info, monthly rent, balances, and occupancy status.",
  {
    property_name: z.string().describe("Property name to pull the rent roll for (e.g. 'Sunflower Estates')"),
  },
  async ({ property_name }) => {
    try {
      const property = await client.findPropertyByName(property_name);
      if (!property) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No property found matching "${property_name}". Try a different name.`,
            },
          ],
        };
      }

      const rentRoll = await client.getRentRoll(property.PropertyID);

      if (rentRoll.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No units found for ${property.Name}.`,
            },
          ],
        };
      }

      const occupied = rentRoll.filter((r) => r.Status === "Occupied").length;
      const vacant = rentRoll.filter((r) => r.Status === "Vacant").length;
      const totalRent = rentRoll.reduce((sum, r) => sum + r.MonthlyRent, 0);
      const totalBalance = rentRoll.reduce((sum, r) => sum + r.Balance, 0);

      let output = `## Rent Roll — ${property.Name}\n\n`;
      output += `**${rentRoll.length} units** | Occupied: **${occupied}** | Vacant: **${vacant}** | Occupancy: **${((occupied / rentRoll.length) * 100).toFixed(1)}%**\n`;
      output += `Total Monthly Rent: **${formatCurrency(totalRent)}** | Outstanding Balances: **${formatCurrency(totalBalance)}**\n\n`;
      output += `| Unit | Tenant | Status | Monthly Rent | Balance | Lease End |\n`;
      output += `|------|--------|--------|-------------|---------|----------|\n`;

      for (const entry of rentRoll) {
        output += `| ${entry.UnitName} | ${entry.TenantName || "—"} | ${entry.Status} | ${formatCurrency(entry.MonthlyRent)} | ${formatCurrency(entry.Balance)} | ${entry.LeaseEnd || "—"} |\n`;
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
    }
  }
);

// ── Tool 5: Get Collections Rate ──

server.tool(
  "get_collections_rate",
  "Compute the collections rate for a property over a date range: total billed (charges) vs total collected (payments), with per-tenant breakdown sorted worst-to-best. Use this to assess payment performance per park.",
  {
    property_name: z.string().describe("Property name to compute collections rate for (partial match supported, e.g. 'Sunflower Estates')"),
    start_date: z.string().describe("Start of the date range, inclusive (ISO YYYY-MM-DD)"),
    end_date: z.string().describe("End of the date range, inclusive (ISO YYYY-MM-DD)"),
  },
  async ({ property_name, start_date, end_date }) => {
    try {
      const property = await client.findPropertyByName(property_name);
      if (!property) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No property found matching "${property_name}". Try a different name.`,
            },
          ],
        };
      }

      const result = await client.getCollectionsRate(property.PropertyID, start_date, end_date);

      if (result.PerTenant.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No charge or payment activity found at ${property.Name} between ${start_date} and ${end_date}. If you expected activity, the ledger Type values may differ from "Charge"/"Payment" — check a tenant's ledger via get_tenant_ledger and update the filter.`,
            },
          ],
        };
      }

      const ratePct = (result.Rate * 100).toFixed(1);
      let output = `## Collections Rate — ${property.Name} (${start_date} → ${end_date})\n\n`;
      output += `Billed: **${formatCurrency(result.TotalBilled)}** | Collected: **${formatCurrency(result.TotalCollected)}** | Rate: **${ratePct}%**\n`;
      output += `Tenants with activity: ${result.PerTenant.length}\n\n`;
      output += `| Tenant | Unit | Billed | Collected | Rate |\n`;
      output += `|--------|------|--------|-----------|------|\n`;

      for (const r of result.PerTenant) {
        output += `| ${r.TenantName} | ${r.UnitName} | ${formatCurrency(r.Billed)} | ${formatCurrency(r.Collected)} | ${(r.Rate * 100).toFixed(1)}% |\n`;
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
    }
  }
);

// ── Start Server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Rent Manager MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting server:", err);
  process.exit(1);
});
