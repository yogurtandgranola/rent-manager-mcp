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
import type {
  RentManagerConfig,
  ApiError,
  Tenant,
  LooseRecord,
  ReportFormat,
  ReportParamValue,
} from "./types.js";

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

function fmtMDY(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

function firstOfYear(): string {
  return fmtMDY(new Date(new Date().getFullYear(), 0, 1));
}

function today(): string {
  return fmtMDY(new Date());
}

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 120);
}

/** Render an array of loosely-shaped API records as a markdown table. */
function renderRecords(records: LooseRecord[], preferredCols?: string[], maxRows = 100): string {
  if (records.length === 0) return "_No rows returned._";

  let cols: string[];
  if (preferredCols) {
    cols = preferredCols.filter((c) => records.some((r) => r[c] !== undefined && r[c] !== null));
  } else {
    // Collect scalar-valued keys in encounter order from a sample of rows
    const seen = new Set<string>();
    for (const r of records.slice(0, 25)) {
      for (const [k, v] of Object.entries(r)) {
        if (v !== null && typeof v === "object") continue;
        seen.add(k);
      }
    }
    cols = [...seen];
  }
  cols = cols.slice(0, 10);
  if (cols.length === 0) cols = Object.keys(records[0]).slice(0, 6);

  let out = `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |\n`;
  for (const r of records.slice(0, maxRows)) {
    out += `| ${cols.map((c) => escapeCell(r[c])).join(" | ")} |\n`;
  }
  if (records.length > maxRows) {
    out += `\n_Showing first ${maxRows} of ${records.length} rows._\n`;
  }
  return out;
}

/** Turn whatever RunReport returned (rows, file URL, or blob of JSON) into readable markdown. */
function formatReportResult(result: unknown): string {
  if (result === null || result === undefined) return "_Report ran but returned no data._";

  if (typeof result === "string") {
    if (/^https?:\/\//i.test(result.trim())) return `📄 Report file ready: ${result.trim()}`;
    return result.length > 6000 ? result.slice(0, 6000) + "\n\n_…truncated_" : result;
  }

  if (Array.isArray(result)) {
    return renderRecords(result as LooseRecord[]);
  }

  if (typeof result === "object") {
    const obj = result as LooseRecord;
    for (const key of ["ReportURL", "PDFUrl", "PdfUrl", "ExcelURL", "ExcelUrl", "FileURL", "FileUrl", "DownloadURL", "URL", "Url"]) {
      const v = obj[key];
      if (typeof v === "string" && v) return `📄 Report file ready: ${v}`;
    }
    for (const key of ["Data", "Rows", "Records", "Results", "Items", "ReportData"]) {
      const v = obj[key];
      if (Array.isArray(v) && v.length > 0) return renderRecords(v as LooseRecord[]);
    }
    const json = JSON.stringify(obj, null, 2);
    return "```json\n" + (json.length > 6000 ? json.slice(0, 6000) + "\n…truncated" : json) + "\n```";
  }

  return String(result);
}

/** Resolve an optional property name to its ID, or return a user-facing error message. */
async function resolvePropertyId(
  property_name?: string
): Promise<{ id?: number; name?: string; error?: string }> {
  if (!property_name) return {};
  const property = await client.findPropertyByName(property_name);
  if (!property) {
    return { error: `No property found matching "${property_name}". Use list_properties to see available names.` };
  }
  return { id: property.PropertyID, name: property.Name };
}

/**
 * Run a financial report by trying a list of likely report names (RM instances
 * name them slightly differently), with shared date/property parameter handling.
 */
async function runFinancialReport(opts: {
  candidates: string[];
  title: string;
  parameters: Record<string, ReportParamValue>;
  format?: ReportFormat;
}) {
  let lastErr: unknown = null;
  for (const candidate of opts.candidates) {
    try {
      const { report, result } = await client.runReportByName(
        candidate,
        opts.parameters,
        opts.format ?? "data"
      );
      let output = `## ${opts.title}\n_Report: ${report.Name} (ID ${report.ReportID})_\n\n`;
      output += formatReportResult(result);
      return ok(output);
    } catch (err) {
      lastErr = err;
    }
  }
  return fail(lastErr);
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
  version: "1.2.0",
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

// ══════════════════════════════════════════════════════════════════
// Report engine — makes EVERY report in the Rent Manager instance
// (built-in and custom) pullable through Claude.
// ══════════════════════════════════════════════════════════════════

// ── Tool: List Reports ──

server.tool(
  "list_reports",
  "List every report available in this Rent Manager instance (built-in and custom) — P&L, balance sheet, owner statements, aged receivables, and everything else. Use this to discover what run_report can pull.",
  {
    search: z.string().optional().describe("Filter reports by name (e.g. 'profit', 'owner', 'aged')"),
  },
  async ({ search }) => {
    try {
      let reports = await client.getReports();
      if (search) {
        const lower = search.toLowerCase();
        reports = reports.filter(
          (r) =>
            r.Name?.toLowerCase().includes(lower) ||
            r.Description?.toLowerCase().includes(lower) ||
            (r.ReportGroup ?? r.Group ?? r.Category ?? "").toLowerCase().includes(lower)
        );
      }
      if (reports.length === 0) {
        return ok(search ? `No reports matching "${search}".` : "No reports found.");
      }

      let output = `## Available Reports (${reports.length})${search ? ` — matching "${search}"` : ""}\n\n`;
      output += `| ID | Report | Group | Description |\n|----|--------|-------|-------------|\n`;
      for (const r of reports) {
        output += `| ${r.ReportID} | ${r.Name} | ${r.ReportGroup ?? r.Group ?? r.Category ?? "—"} | ${(r.Description ?? "—").slice(0, 100)} |\n`;
      }
      output += `\nRun any of these with **run_report** (check parameters first with **get_report_info**).`;
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Report Info ──

server.tool(
  "get_report_info",
  "Show the parameters a Rent Manager report accepts (names, types, defaults) before running it with run_report. Accepts a report name or ID.",
  {
    report: z.string().describe("Report name (partial match OK, e.g. 'profit and loss') or numeric report ID"),
  },
  async ({ report }) => {
    try {
      const def = await client.findReport(report);
      if (!def) {
        return ok(`No report matching "${report}". Use list_reports to browse what's available.`);
      }

      const params = await client.getReportParameters(def.ReportID);

      let output = `## ${def.Name} (ID ${def.ReportID})\n`;
      if (def.Description) output += `${def.Description}\n`;
      output += `\n### Parameters\n\n`;
      if (params.length === 0) {
        output += `No parameter metadata returned — common parameters are PropertyIDs, StartDate, EndDate, AsOfDate (dates as MM/DD/YYYY).\n`;
      } else {
        output += renderRecords(params);
      }
      output += `\nRun it with **run_report** — e.g. \`{"report": "${def.Name}", "parameters": {"PropertyIDs": [1,2], "StartDate": "01/01/${new Date().getFullYear()}", "EndDate": "${today()}"}}\``;
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Run Report ──

server.tool(
  "run_report",
  "Run ANY Rent Manager report by name or ID with arbitrary parameters — the universal escape hatch for reports without a dedicated tool. Dates use MM/DD/YYYY. Set format to 'pdf' or 'excel' to get a downloadable file link instead of data. If a run fails, check parameter names with get_report_info.",
  {
    report: z.string().describe("Report name (partial match OK) or numeric report ID"),
    parameters: z
      .record(
        z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
      )
      .optional()
      .describe('Report parameters, e.g. {"PropertyIDs": [1,2], "StartDate": "01/01/2026", "EndDate": "06/30/2026"}. Arrays are serialized as multi-value parameters.'),
    property_name: z.string().optional().describe("Convenience: resolves a property name to PropertyIDs for you"),
    format: z.enum(["data", "pdf", "excel"]).optional().describe("'data' (default) returns rows inline; 'pdf'/'excel' return a file link"),
  },
  async ({ report, parameters, property_name, format }) => {
    try {
      const params: Record<string, ReportParamValue> = { ...(parameters ?? {}) };

      const prop = await resolvePropertyId(property_name);
      if (prop.error) return ok(prop.error);
      if (prop.id && !params.PropertyIDs) params.PropertyIDs = [prop.id];

      const { report: def, result } = await client.runReportByName(report, params, format ?? "data");

      let output = `## ${def.Name}${prop.name ? ` — ${prop.name}` : ""}\n`;
      if (Object.keys(params).length) {
        output += `_Parameters: ${Object.entries(params).map(([k, v]) => `${k}=${Array.isArray(v) ? `(${v.join(",")})` : v}`).join(", ")}_\n`;
      }
      output += `\n${formatReportResult(result)}`;
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// Financial statements — first-class wrappers over the report engine
// ══════════════════════════════════════════════════════════════════

// ── Tool: Profit & Loss ──

server.tool(
  "get_profit_and_loss",
  "Pull a Profit & Loss (income statement) for the portfolio or one property over a date range. Defaults to year-to-date. Set format to 'pdf' or 'excel' for a downloadable file.",
  {
    property_name: z.string().optional().describe("Property to scope to. Omit for all properties."),
    start_date: z.string().optional().describe("Start date MM/DD/YYYY (default: Jan 1 of this year)"),
    end_date: z.string().optional().describe("End date MM/DD/YYYY (default: today)"),
    format: z.enum(["data", "pdf", "excel"]).optional(),
    extra_parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Additional report parameters if your instance needs them (e.g. accounting basis)"),
  },
  async ({ property_name, start_date, end_date, format, extra_parameters }) => {
    const prop = await resolvePropertyId(property_name);
    if (prop.error) return ok(prop.error);

    const parameters: Record<string, ReportParamValue> = {
      StartDate: start_date ?? firstOfYear(),
      EndDate: end_date ?? today(),
      ...(extra_parameters ?? {}),
    };
    if (prop.id) parameters.PropertyIDs = [prop.id];

    return runFinancialReport({
      candidates: ["profit & loss", "profit and loss", "income statement", "profit"],
      title: `Profit & Loss${prop.name ? ` — ${prop.name}` : ""} (${parameters.StartDate} to ${parameters.EndDate})`,
      parameters,
      format,
    });
  }
);

// ── Tool: Balance Sheet ──

server.tool(
  "get_balance_sheet",
  "Pull a Balance Sheet as of a given date for the portfolio or one property. Set format to 'pdf' or 'excel' for a downloadable file.",
  {
    property_name: z.string().optional().describe("Property to scope to. Omit for all properties."),
    as_of_date: z.string().optional().describe("As-of date MM/DD/YYYY (default: today)"),
    format: z.enum(["data", "pdf", "excel"]).optional(),
    extra_parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  },
  async ({ property_name, as_of_date, format, extra_parameters }) => {
    const prop = await resolvePropertyId(property_name);
    if (prop.error) return ok(prop.error);

    const parameters: Record<string, ReportParamValue> = {
      AsOfDate: as_of_date ?? today(),
      ...(extra_parameters ?? {}),
    };
    if (prop.id) parameters.PropertyIDs = [prop.id];

    return runFinancialReport({
      candidates: ["balance sheet"],
      title: `Balance Sheet${prop.name ? ` — ${prop.name}` : ""} (as of ${parameters.AsOfDate})`,
      parameters,
      format,
    });
  }
);

// ── Tool: Cash Flow ──

server.tool(
  "get_cash_flow",
  "Pull a Cash Flow statement for the portfolio or one property over a date range. Defaults to year-to-date. Set format to 'pdf' or 'excel' for a downloadable file.",
  {
    property_name: z.string().optional().describe("Property to scope to. Omit for all properties."),
    start_date: z.string().optional().describe("Start date MM/DD/YYYY (default: Jan 1 of this year)"),
    end_date: z.string().optional().describe("End date MM/DD/YYYY (default: today)"),
    format: z.enum(["data", "pdf", "excel"]).optional(),
    extra_parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  },
  async ({ property_name, start_date, end_date, format, extra_parameters }) => {
    const prop = await resolvePropertyId(property_name);
    if (prop.error) return ok(prop.error);

    const parameters: Record<string, ReportParamValue> = {
      StartDate: start_date ?? firstOfYear(),
      EndDate: end_date ?? today(),
      ...(extra_parameters ?? {}),
    };
    if (prop.id) parameters.PropertyIDs = [prop.id];

    return runFinancialReport({
      candidates: ["cash flow", "statement of cash flows"],
      title: `Cash Flow${prop.name ? ` — ${prop.name}` : ""} (${parameters.StartDate} to ${parameters.EndDate})`,
      parameters,
      format,
    });
  }
);

// ── Tool: Owner Statement ──

server.tool(
  "get_owner_statement",
  "Pull an owner statement (distributions/activity) for an owner over a date range. Defaults to year-to-date. Set format to 'pdf' for the send-ready file.",
  {
    owner_name: z.string().optional().describe("Owner name to scope the statement to (partial match OK)"),
    property_name: z.string().optional().describe("Property to scope to instead of / in addition to owner"),
    start_date: z.string().optional().describe("Start date MM/DD/YYYY (default: Jan 1 of this year)"),
    end_date: z.string().optional().describe("End date MM/DD/YYYY (default: today)"),
    format: z.enum(["data", "pdf", "excel"]).optional(),
    extra_parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  },
  async ({ owner_name, property_name, start_date, end_date, format, extra_parameters }) => {
    try {
      const prop = await resolvePropertyId(property_name);
      if (prop.error) return ok(prop.error);

      const parameters: Record<string, ReportParamValue> = {
        StartDate: start_date ?? firstOfYear(),
        EndDate: end_date ?? today(),
        ...(extra_parameters ?? {}),
      };
      if (prop.id) parameters.PropertyIDs = [prop.id];

      let ownerLabel = "";
      if (owner_name) {
        const owners = await client.getOwners();
        const lower = owner_name.toLowerCase();
        const matches = owners.filter((o) =>
          String(o.Name ?? o.DisplayName ?? `${o.FirstName ?? ""} ${o.LastName ?? ""}`).toLowerCase().includes(lower)
        );
        if (matches.length === 0) {
          return ok(`No owner found matching "${owner_name}". Use list_owners to see available owners.`);
        }
        if (matches.length > 1) {
          const names = matches.map((o) => `- ${o.Name ?? o.DisplayName ?? `${o.FirstName ?? ""} ${o.LastName ?? ""}`}`).join("\n");
          return ok(`Found ${matches.length} owners matching "${owner_name}" — be more specific:\n\n${names}`);
        }
        const ownerId = matches[0].OwnerID as number;
        parameters.OwnerIDs = [ownerId];
        ownerLabel = ` — ${matches[0].Name ?? matches[0].DisplayName ?? owner_name}`;
      }

      return runFinancialReport({
        candidates: ["owner statement", "owner"],
        title: `Owner Statement${ownerLabel}${prop.name ? ` — ${prop.name}` : ""} (${parameters.StartDate} to ${parameters.EndDate})`,
        parameters,
        format,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Chart of Accounts ──

server.tool(
  "get_chart_of_accounts",
  "List the general-ledger chart of accounts (account numbers, names, types). Useful before drilling into financials.",
  {},
  async () => {
    try {
      const accounts = await client.getGLAccounts();
      if (accounts.length === 0) return ok("No GL accounts found.");

      let output = `## Chart of Accounts (${accounts.length})\n\n`;
      output += `| # | Account | Type | Description |\n|---|---------|------|-------------|\n`;
      for (const a of accounts) {
        output += `| ${a.AccountNumber ?? a.Number ?? a.GLAccountID} | ${a.Name} | ${a.GLAccountType ?? a.Type ?? "—"} | ${(a.Description ?? "—").slice(0, 80)} |\n`;
      }
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════
// Owners, vendors, payables, prospects — the rest of the platform
// ══════════════════════════════════════════════════════════════════

// ── Tool: List Owners ──

server.tool(
  "list_owners",
  "List property owners with contact info and the properties they own.",
  {},
  async () => {
    try {
      const owners = await client.getOwners();
      if (owners.length === 0) return ok("No owners found.");
      let output = `## Owners (${owners.length})\n\n`;
      output += renderRecords(owners, ["OwnerID", "Name", "DisplayName", "FirstName", "LastName", "Email", "Phone", "IsActive"]);
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: List Vendors ──

server.tool(
  "list_vendors",
  "List vendors/suppliers with contact info — useful when creating work orders or reviewing payables.",
  {},
  async () => {
    try {
      const vendors = await client.getVendors();
      if (vendors.length === 0) return ok("No vendors found.");
      let output = `## Vendors (${vendors.length})\n\n`;
      output += renderRecords(vendors, ["VendorID", "Name", "DisplayName", "Email", "Phone", "IsActive"]);
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Bills ──

server.tool(
  "get_bills",
  "Pull accounts-payable bills, unpaid ones by default. Optionally filter to one property or include paid bills.",
  {
    property_name: z.string().optional().describe("Property to filter by. Omit for all properties."),
    include_paid: z.boolean().optional().describe("Include fully paid bills (default false)"),
  },
  async ({ property_name, include_paid }) => {
    try {
      const prop = await resolvePropertyId(property_name);
      if (prop.error) return ok(prop.error);

      const bills = await client.getBills(!(include_paid ?? false), prop.id);
      if (bills.length === 0) {
        return ok(`No ${include_paid ? "" : "unpaid "}bills found${prop.name ? ` at ${prop.name}` : ""}.`);
      }

      let output = `## Bills${prop.name ? ` — ${prop.name}` : ""} (${bills.length})\n\n`;
      output += renderRecords(bills, ["BillID", "VendorName", "Reference", "Memo", "Amount", "BillDate", "DueDate", "IsFullyAllocated"]);
      return ok(output);
    } catch (err) {
      return fail(err);
    }
  }
);

// ── Tool: Get Prospects ──

server.tool(
  "get_prospects",
  "Pull leasing prospects/leads, optionally filtered to one property — useful for tracking the leasing pipeline alongside the vacancy report.",
  {
    property_name: z.string().optional().describe("Property to filter by. Omit for all properties."),
  },
  async ({ property_name }) => {
    try {
      const prop = await resolvePropertyId(property_name);
      if (prop.error) return ok(prop.error);

      const prospects = await client.getProspects(prop.id);
      if (prospects.length === 0) {
        return ok(`No prospects found${prop.name ? ` at ${prop.name}` : ""}.`);
      }

      let output = `## Prospects${prop.name ? ` — ${prop.name}` : ""} (${prospects.length})\n\n`;
      output += renderRecords(prospects, ["ProspectID", "FirstName", "LastName", "Name", "Email", "Phone", "Status", "PropertyName", "UnitName"]);
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
