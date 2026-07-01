#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadDotEnv } from "./env.js";
import { RentManagerClient } from "./rent-manager-client.js";
import { renderDashboardHTML } from "./dashboard.js";
import { demoSnapshot } from "./demo-data.js";
import type { RentManagerConfig, ApiError, Tenant } from "./types.js";

// ── Configuration ──

function loadConfig(): RentManagerConfig {
  loadDotEnv();
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

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
}

function tenantLine(t: Tenant): string {
  return `${t.FirstName} ${t.LastName} — Unit ${t.UnitName} at ${t.PropertyName} (ID: ${t.TenantID})`;
}

/** Resolve a tenant from either a name or property+unit, shared by several tools. */
async function resolveTenants(input: {
  tenant_name?: string;
  property_name?: string;
  unit_name?: string;
}): Promise<Tenant[] | string> {
  if (input.tenant_name) {
    return client.findTenantByName(input.tenant_name);
  }
  if (input.property_name && input.unit_name) {
    return client.findTenantByUnit(input.property_name, input.unit_name);
  }
  return "Please provide either a tenant_name OR both property_name and unit_name.";
}

// ── Server Setup ──

const config = loadConfig();
const client = new RentManagerClient(config);

const server = new McpServer({
  name: "rent-manager",
  version: "1.1.0",
});

// ── Tool: List Properties ──

server.tool(
  "list_properties",
  "List all properties in the portfolio with addresses and unit counts. Useful as a first step to find exact property names.",
  {},
  async () => {
    try {
      const properties = await client.getProperties();
      if (properties.length === 0) return ok("No properties found.");

      let output = `## Properties (${properties.length})\n\n`;
      output += `| Property | Address | Units |\n|----------|---------|-------|\n`;
      for (const p of properties) {
        const address = [p.Address, p.City, p.State].filter(Boolean).join(", ");
        output += `| ${p.Name} | ${address || "—"} | ${p.UnitCount ?? "—"} |\n`;
      }
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Delinquencies ──

server.tool(
  "get_delinquencies",
  "Pull delinquency data for a property. Shows tenants with outstanding balances, sorted by amount owed. You can search by property name (e.g. 'Sunflower Estates').",
  {
    property_name: z.string().optional().describe("Property name to filter by (partial match supported). Omit to get all properties."),
    min_balance: z.number().optional().describe("Only show tenants owing at least this amount"),
  },
  async ({ property_name, min_balance }) => {
    try {
      let propertyId: number | undefined;

      if (property_name) {
        const property = await client.findPropertyByName(property_name);
        if (!property) {
          return ok(`No property found matching "${property_name}". Use list_properties to see available names.`);
        }
        propertyId = property.PropertyID;
      }

      let records = await client.getDelinquencies(propertyId);
      if (min_balance) {
        records = records.filter((r) => r.Balance >= min_balance);
      }

      if (records.length === 0) {
        return ok(
          property_name
            ? `No delinquencies found at ${property_name}. 🎉`
            : "No delinquencies found across any properties."
        );
      }

      const totalOwed = records.reduce((sum, r) => sum + r.Balance, 0);

      let output = `## Delinquency Report${property_name ? ` — ${property_name}` : ""}\n\n`;
      output += `**${records.length} delinquent tenant(s)** | Total owed: **${formatCurrency(totalOwed)}**\n\n`;
      output += `| Tenant | Unit | Property | Balance | Days Past Due |\n`;
      output += `|--------|------|----------|---------|---------------|\n`;

      for (const r of records) {
        output += `| ${r.TenantName} | ${r.UnitName} | ${r.PropertyName} | ${formatCurrency(r.Balance)} | ${r.DaysPastDue || "N/A"} |\n`;
      }

      if (records.some((r) => r.LastPaymentDate)) {
        output += `\n### Last Payment Info\n`;
        for (const r of records.filter((r) => r.LastPaymentDate)) {
          output += `- **${r.TenantName}**: Last paid ${formatCurrency(r.LastPaymentAmount ?? 0)} on ${r.LastPaymentDate}\n`;
        }
      }

      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Search Tenants ──

server.tool(
  "search_tenants",
  "Search tenants by name, email, phone number, status, and/or property across the whole portfolio. Returns contact info, unit, and current balance.",
  {
    name: z.string().optional().describe("Full or partial tenant name"),
    email: z.string().optional().describe("Full or partial email address"),
    phone: z.string().optional().describe("Full or partial phone number"),
    status: z.string().optional().describe("Tenant status (e.g. 'Current', 'Past', 'Future')"),
    property_name: z.string().optional().describe("Limit results to one property"),
  },
  async ({ name, email, phone, status, property_name }) => {
    try {
      if (!name && !email && !phone && !status && !property_name) {
        return ok("Provide at least one search criterion: name, email, phone, status, or property_name.");
      }

      const tenants = await client.searchTenants({ name, email, phone, status, propertyName: property_name });
      if (tenants.length === 0) return ok("No tenants matched your search.");

      let output = `## Tenant Search Results (${tenants.length})\n\n`;
      output += `| Tenant | Unit | Property | Email | Phone | Balance |\n`;
      output += `|--------|------|----------|-------|-------|--------|\n`;
      for (const t of tenants.slice(0, 50)) {
        output += `| ${t.FirstName} ${t.LastName} | ${t.UnitName || "—"} | ${t.PropertyName || "—"} | ${t.Email || "—"} | ${t.Phone || "—"} | ${formatCurrency(t.Balance ?? 0)} |\n`;
      }
      if (tenants.length > 50) {
        output += `\n_Showing first 50 of ${tenants.length} matches — narrow your search for more specific results._`;
      }
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Tenant Ledger ──

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
      const resolved = await resolveTenants({ tenant_name, property_name, unit_name });
      if (typeof resolved === "string") return ok(resolved);

      if (resolved.length === 0) {
        return ok(`No tenant found matching your search. Try a different name or unit number.`);
      }

      let output = "";
      if (resolved.length > 1) {
        output += `Found ${resolved.length} tenants matching your search. Showing ledger for the first match.\n\n**All matches:**\n`;
        for (const t of resolved) output += `- ${tenantLine(t)}\n`;
        output += `\n---\n\n`;
      }

      const tenant = resolved[0];
      const ledger = await client.getTenantLedger(tenant.TenantID);

      output += `## Ledger for ${tenant.FirstName} ${tenant.LastName}\n`;
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

      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Tenant Balance ──

server.tool(
  "get_tenant_balance",
  "Quick balance check for a tenant — faster than pulling the full ledger. Search by tenant name or property + unit.",
  {
    tenant_name: z.string().optional().describe("Tenant name to search for"),
    property_name: z.string().optional().describe("Property name (used with unit_name)"),
    unit_name: z.string().optional().describe("Unit number/name (used with property_name)"),
  },
  async ({ tenant_name, property_name, unit_name }) => {
    try {
      const resolved = await resolveTenants({ tenant_name, property_name, unit_name });
      if (typeof resolved === "string") return ok(resolved);
      if (resolved.length === 0) return ok("No tenant found matching your search.");

      let output = "";
      for (const t of resolved.slice(0, 10)) {
        const emoji = t.Balance > 0 ? "🔴" : "🟢";
        output += `${emoji} **${t.FirstName} ${t.LastName}** (Unit ${t.UnitName}, ${t.PropertyName}): **${formatCurrency(t.Balance ?? 0)}**\n`;
      }
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Add Tenant Note ──

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
      const resolved = await resolveTenants({ tenant_name, property_name, unit_name });
      if (typeof resolved === "string") return ok(resolved + " Note was NOT saved.");

      if (resolved.length === 0) {
        return ok(`No tenant found matching your search. Note was NOT saved.`);
      }

      if (resolved.length > 1) {
        let output = `Found ${resolved.length} tenants matching your search. Please be more specific:\n\n`;
        for (const t of resolved) output += `- ${tenantLine(t)}\n`;
        output += `\nNote was NOT saved. Narrow your search to a single tenant.`;
        return ok(output);
      }

      const tenant = resolved[0];
      const result = await client.addTenantNote(tenant.TenantID, note);

      let output = `✅ Note added to **${tenant.FirstName} ${tenant.LastName}**'s record\n\n`;
      output += `- **Unit:** ${tenant.UnitName} at ${tenant.PropertyName}\n`;
      output += `- **Date:** ${result.Date}\n`;
      output += `- **Note ID:** ${result.NoteID}\n\n`;
      output += `> ${note.length > 200 ? note.substring(0, 200) + "..." : note}`;

      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Rent Roll ──

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
        return ok(`No property found matching "${property_name}". Use list_properties to see available names.`);
      }

      const rentRoll = await client.getRentRoll(property.PropertyID);

      if (rentRoll.length === 0) {
        return ok(`No units found for ${property.Name}.`);
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

      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Vacancy Report ──

server.tool(
  "get_vacancy_report",
  "Show all vacant units with market rent and days vacant, sorted by longest-vacant first. Optionally filter to one property.",
  {
    property_name: z.string().optional().describe("Property name to filter by. Omit for all properties."),
  },
  async ({ property_name }) => {
    try {
      let propertyId: number | undefined;
      if (property_name) {
        const property = await client.findPropertyByName(property_name);
        if (!property) {
          return ok(`No property found matching "${property_name}". Use list_properties to see available names.`);
        }
        propertyId = property.PropertyID;
      }

      const vacant = await client.getVacantUnits(propertyId);
      if (vacant.length === 0) {
        return ok(`No vacant units${property_name ? ` at ${property_name}` : ""}. 🎉`);
      }

      const lostRent = vacant.reduce((sum, v) => sum + v.MarketRent, 0);

      let output = `## Vacancy Report${property_name ? ` — ${property_name}` : ""}\n\n`;
      output += `**${vacant.length} vacant unit(s)** | Unrealized market rent: **${formatCurrency(lostRent)}/mo**\n\n`;
      output += `| Unit | Property | Market Rent | Last Move-Out | Days Vacant |\n`;
      output += `|------|----------|-------------|---------------|-------------|\n`;
      for (const v of vacant) {
        output += `| ${v.UnitName} | ${v.PropertyName} | ${formatCurrency(v.MarketRent)} | ${v.LastMoveOutDate ?? "—"} | ${v.DaysVacant ?? "—"} |\n`;
      }
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Expiring Leases ──

server.tool(
  "get_expiring_leases",
  "Show leases expiring within a date window for renewal planning, sorted soonest-first. Defaults to the next 90 days.",
  {
    within_days: z.number().optional().describe("How many days ahead to look (default 90)"),
    property_name: z.string().optional().describe("Property name to filter by. Omit for all properties."),
  },
  async ({ within_days, property_name }) => {
    try {
      const days = within_days ?? 90;
      let propertyId: number | undefined;
      if (property_name) {
        const property = await client.findPropertyByName(property_name);
        if (!property) {
          return ok(`No property found matching "${property_name}". Use list_properties to see available names.`);
        }
        propertyId = property.PropertyID;
      }

      const leases = await client.getExpiringLeases(days, propertyId);
      if (leases.length === 0) {
        return ok(`No leases expiring in the next ${days} days${property_name ? ` at ${property_name}` : ""}.`);
      }

      let output = `## Expiring Leases — next ${days} days${property_name ? ` — ${property_name}` : ""}\n\n`;
      output += `**${leases.length} lease(s)** coming up for renewal\n\n`;
      output += `| Tenant | Unit | Property | Lease Ends | Days Left | Rent |\n`;
      output += `|--------|------|----------|------------|-----------|------|\n`;
      for (const l of leases) {
        const urgency = l.DaysUntilExpiration <= 30 ? " ⚠️" : "";
        output += `| ${l.TenantName} | ${l.UnitName} | ${l.PropertyName} | ${l.LeaseEnd.slice(0, 10)} | ${l.DaysUntilExpiration}${urgency} | ${l.MonthlyRent != null ? formatCurrency(l.MonthlyRent) : "—"} |\n`;
      }
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Work Orders ──

server.tool(
  "get_work_orders",
  "Pull maintenance/service work orders, open ones by default. Optionally filter to one property or include closed orders.",
  {
    property_name: z.string().optional().describe("Property name to filter by. Omit for all properties."),
    include_closed: z.boolean().optional().describe("Include closed/completed work orders (default false)"),
  },
  async ({ property_name, include_closed }) => {
    try {
      let propertyId: number | undefined;
      if (property_name) {
        const property = await client.findPropertyByName(property_name);
        if (!property) {
          return ok(`No property found matching "${property_name}". Use list_properties to see available names.`);
        }
        propertyId = property.PropertyID;
      }

      const orders = await client.getWorkOrders(propertyId, include_closed ?? false);
      if (orders.length === 0) {
        return ok(`No ${include_closed ? "" : "open "}work orders found${property_name ? ` at ${property_name}` : ""}.`);
      }

      let output = `## Work Orders${property_name ? ` — ${property_name}` : ""} (${orders.length})\n\n`;
      output += `| # | Title | Status | Priority | Unit | Property | Created |\n`;
      output += `|---|-------|--------|----------|------|----------|--------|\n`;
      for (const w of orders) {
        output += `| ${w.WorkOrderID} | ${w.Title} | ${w.Status} | ${w.Priority ?? "—"} | ${w.UnitName ?? "—"} | ${w.PropertyName ?? "—"} | ${w.CreatedDate?.slice(0, 10) ?? "—"} |\n`;
      }
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Create Work Order ──

server.tool(
  "create_work_order",
  "Create a new maintenance work order in Rent Manager. Provide a title, description, and the tenant (by name) or property/unit it applies to.",
  {
    title: z.string().describe("Short title for the work order (e.g. 'Leaky kitchen faucet')"),
    description: z.string().describe("Full description of the issue"),
    tenant_name: z.string().optional().describe("Tenant reporting the issue (links the order to their unit)"),
    property_name: z.string().optional().describe("Property the issue is at"),
    unit_name: z.string().optional().describe("Unit the issue is in (used with property_name)"),
  },
  async ({ title, description, tenant_name, property_name, unit_name }) => {
    try {
      let tenantId: number | undefined;
      let unitId: number | undefined;
      let propertyId: number | undefined;
      let context = "";

      if (tenant_name || (property_name && unit_name)) {
        const resolved = await resolveTenants({ tenant_name, property_name, unit_name });
        if (typeof resolved !== "string" && resolved.length === 1) {
          const t = resolved[0];
          tenantId = t.TenantID;
          unitId = t.UnitID;
          propertyId = t.PropertyID;
          context = ` for **${t.FirstName} ${t.LastName}** (Unit ${t.UnitName}, ${t.PropertyName})`;
        } else if (typeof resolved !== "string" && resolved.length > 1) {
          let output = `Found ${resolved.length} matching tenants — please be more specific:\n\n`;
          for (const t of resolved) output += `- ${tenantLine(t)}\n`;
          output += `\nWork order was NOT created.`;
          return ok(output);
        }
      }

      if (!propertyId && property_name) {
        const property = await client.findPropertyByName(property_name);
        if (property) {
          propertyId = property.PropertyID;
          context = context || ` at **${property.Name}**`;
        }
      }

      const created = await client.createWorkOrder({ title, description, propertyId, unitId, tenantId });

      let output = `✅ Work order **#${created.WorkOrderID}** created${context}\n\n`;
      output += `- **Title:** ${created.Title}\n`;
      output += `- **Status:** ${created.Status}\n\n`;
      output += `> ${description.length > 300 ? description.slice(0, 300) + "..." : description}`;
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Property Summary ──

server.tool(
  "get_property_summary",
  "High-level portfolio overview: occupancy, scheduled rent, and delinquency totals for every property (or one property). Good starting point for any analysis.",
  {
    property_name: z.string().optional().describe("Property name for a single-property summary. Omit for the whole portfolio."),
  },
  async ({ property_name }) => {
    try {
      let propertyId: number | undefined;
      if (property_name) {
        const property = await client.findPropertyByName(property_name);
        if (!property) {
          return ok(`No property found matching "${property_name}". Use list_properties to see available names.`);
        }
        propertyId = property.PropertyID;
      }

      const summaries = await client.getPropertySummaries(propertyId);
      if (summaries.length === 0) return ok("No properties found.");

      const totalUnits = summaries.reduce((s, p) => s + p.TotalUnits, 0);
      const occupied = summaries.reduce((s, p) => s + p.OccupiedUnits, 0);
      const rent = summaries.reduce((s, p) => s + p.ScheduledMonthlyRent, 0);
      const delinquent = summaries.reduce((s, p) => s + p.DelinquentBalance, 0);

      let output = `## Portfolio Summary${property_name ? ` — ${property_name}` : ""}\n\n`;
      output += `**${totalUnits} units** | Occupancy: **${totalUnits ? ((occupied / totalUnits) * 100).toFixed(1) : 0}%** | Scheduled rent: **${formatCurrency(rent)}/mo** | Outstanding: **${formatCurrency(delinquent)}**\n\n`;
      output += `| Property | Units | Occupied | Occupancy | Scheduled Rent | Delinquent | Owed |\n`;
      output += `|----------|-------|----------|-----------|----------------|------------|------|\n`;
      for (const p of summaries) {
        output += `| ${p.PropertyName} | ${p.TotalUnits} | ${p.OccupiedUnits} | ${p.OccupancyRate.toFixed(1)}% | ${formatCurrency(p.ScheduledMonthlyRent)} | ${p.DelinquentTenants} | ${formatCurrency(p.DelinquentBalance)} |\n`;
      }
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Generate Dashboard ──

server.tool(
  "generate_dashboard",
  "Generate a self-contained HTML dashboard (occupancy, delinquency, expiring leases, vacancies) that can be emailed or shared with the team — viewers need nothing but a browser. Saves the file and returns its path. Use demo_data:true to preview with sample data before wiring up credentials.",
  {
    property_name: z.string().optional().describe("Scope the dashboard to one property. Omit for the whole portfolio."),
    output_path: z.string().optional().describe("Where to save the HTML file (default: ./rent-dashboard-YYYY-MM-DD.html)"),
    demo_data: z.boolean().optional().describe("Use built-in sample data instead of calling the Rent Manager API"),
  },
  async ({ property_name, output_path, demo_data }) => {
    try {
      let snapshot;
      let scopeLabel: string | undefined;

      if (demo_data) {
        snapshot = demoSnapshot();
        scopeLabel = "Demo Data";
      } else {
        let propertyId: number | undefined;
        if (property_name) {
          const property = await client.findPropertyByName(property_name);
          if (!property) {
            return ok(`No property found matching "${property_name}". Use list_properties to see available names.`);
          }
          propertyId = property.PropertyID;
          scopeLabel = property.Name;
        }
        snapshot = await client.getPortfolioSnapshot(propertyId);
      }

      const html = renderDashboardHTML(snapshot, scopeLabel);
      const date = new Date().toISOString().slice(0, 10);
      const outPath = resolve(output_path ?? `rent-dashboard-${date}.html`);
      writeFileSync(outPath, html, "utf8");

      const totalUnits = snapshot.properties.reduce((s, p) => s + p.TotalUnits, 0);
      const occupied = snapshot.properties.reduce((s, p) => s + p.OccupiedUnits, 0);
      const owed = snapshot.delinquencies.reduce((s, d) => s + d.Balance, 0);

      let output = `✅ Dashboard saved to **${outPath}**\n\n`;
      output += `Snapshot: ${snapshot.properties.length} properties · ${occupied}/${totalUnits} units occupied (${totalUnits ? ((occupied / totalUnits) * 100).toFixed(1) : 0}%) · ${formatCurrency(owed)} outstanding · ${snapshot.expiringLeases.length} leases expiring ≤ 90 days\n\n`;
      output += `The file is fully self-contained — attach it to an email or drop it in Slack and anyone can open it in a browser. It supports light/dark mode, hover tooltips, table views, and prints cleanly.`;
      return ok(output);
    } catch (err) {
      return fail(err);
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
