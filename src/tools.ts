import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RentManagerError } from "./rent-manager-client.js";
import { csv, day, money, pct, table, truncate } from "./format.js";
import {
  buildLedger,
  computeAging,
  RentManagerService,
  tenantName,
  unitLabel,
  UserFacingError,
} from "./services.js";
import type { RentRollRow, Tenant } from "./types.js";

const MAX_OUTPUT_CHARS = 60_000;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(body: string): ToolResult {
  const clipped =
    body.length > MAX_OUTPUT_CHARS
      ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n\n…output truncated at ${MAX_OUTPUT_CHARS.toLocaleString()} characters. Narrow the request (property, date range, limit).`
      : body;
  return { content: [{ type: "text", text: clipped }] };
}

export function formatError(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  if (err instanceof RentManagerError) {
    return err.status === 0
      ? `Could not reach Rent Manager: ${err.message}`
      : `Rent Manager API error on ${err.endpoint}: ${err.message}`;
  }
  if (err instanceof Error) return `Error: ${err.message}`;
  return `Unexpected error: ${String(err)}`;
}

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    return { ...text(formatError(err)), isError: true };
  }
}

// ── Shared input schemas ──

const tenantSelector = {
  tenant_id: z.number().int().positive().optional().describe("Rent Manager TenantID. Most precise; use it when a search returned several matches."),
  tenant_name: z.string().min(1).optional().describe("Tenant name, e.g. 'John Smith'. Partial names work."),
  property_name: z.string().min(1).optional().describe("Property name or ID. Narrows a name search, or combine with unit_name."),
  unit_name: z.string().min(1).optional().describe("Unit/lot name or number, e.g. '12' or 'Lot 12'. Requires property_name."),
};

type TenantSelector = { tenant_id?: number; tenant_name?: string; property_name?: string; unit_name?: string };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, svc: RentManagerService): void {
  const resolveTenant = (args: TenantSelector) =>
    svc.resolveTenant({
      tenantId: args.tenant_id,
      tenantName: args.tenant_name,
      propertyName: args.property_name,
      unitName: args.unit_name,
    });

  const tenantHeader = async (t: Tenant) => {
    const label = (await svc.labelTenants([t])).get(t.TenantID);
    return (
      `**Tenant ID:** ${t.TenantID} | **Unit:** ${label?.unitName ?? "-"} | **Property:** ${label?.propertyName ?? "-"} | ` +
      `**Status:** ${t.IsActive === false ? "Past" : "Current"} | **Balance:** ${money(t.CurrentBalance)}\n`
    );
  };

  // ── Connection & lookup ──

  server.registerTool(
    "test_connection",
    {
      title: "Test Rent Manager connection",
      description: "Check that the server can log in to Rent Manager and read data. Run this first if other tools fail.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const started = Date.now();
        const properties = await svc.listProperties(true);
        const active = properties.filter((p) => p.IsActive !== false).length;
        return [
          "Connected to Rent Manager.",
          `- API: ${svc.config.baseUrl}`,
          `- Location ID: ${svc.config.locationId}`,
          `- Auth: ${svc.config.username ? `user "${svc.config.username}"` : "API token"}`,
          `- Properties visible: ${properties.length} (${active} active)`,
          `- Mode: ${svc.config.readOnly ? "read-only (write tools disabled)" : "read/write"}`,
          `- Round trip: ${Date.now() - started} ms`,
        ].join("\n");
      })
  );

  server.registerTool(
    "list_properties",
    {
      title: "List properties",
      description: "List the properties (communities) in Rent Manager with their IDs.",
      inputSchema: {
        include_inactive: z.boolean().default(false).describe("Include inactive/sold properties"),
      },
      annotations: READ_ONLY,
    },
    ({ include_inactive }) =>
      run(async () => {
        const properties = await svc.listProperties(include_inactive);
        if (!properties.length) return "No properties found for this API user and location.";
        return (
          `## Properties (${properties.length})\n\n` +
          table(
            ["Name", "Short Name", "Property ID", "Active"],
            properties.map((p) => [p.Name, p.ShortName, p.PropertyID, p.IsActive === false ? "No" : "Yes"])
          )
        );
      })
  );

  server.registerTool(
    "search_tenants",
    {
      title: "Search tenants",
      description:
        "Find tenants by name, email, or tenant ID, optionally within one property. Returns tenant IDs to use with the other tools.",
      inputSchema: {
        query: z.string().min(1).describe("Name (full or partial), email address, or tenant ID"),
        property_name: z.string().min(1).optional().describe("Limit to one property (name or ID)"),
        active_only: z.boolean().default(false).describe("Only current tenants"),
        limit: z.number().int().min(1).max(200).default(25),
      },
      annotations: READ_ONLY,
    },
    ({ query, property_name, active_only, limit }) =>
      run(async () => {
        const property = property_name ? await svc.resolveProperty(property_name) : undefined;
        const tenants = await svc.searchTenants(query, { propertyId: property?.PropertyID, activeOnly: active_only });
        if (!tenants.length) return `No tenants match "${query}"${property ? ` at ${property.Name}` : ""}.`;
        const shown = tenants.slice(0, limit);
        const labels = await svc.labelTenants(shown);
        return (
          `## Tenants matching "${query}"${property ? ` at ${property.Name}` : ""}\n\n` +
          `Showing ${shown.length} of ${tenants.length}.\n\n` +
          table(
            ["Name", "Tenant ID", "Unit", "Property", "Status", "Balance", "Email"],
            shown.map((t) => [
              tenantName(t),
              t.TenantID,
              labels.get(t.TenantID)?.unitName,
              labels.get(t.TenantID)?.propertyName,
              t.IsActive === false ? "Past" : "Current",
              money(t.CurrentBalance),
              t.Email,
            ])
          )
        );
      })
  );

  // ── Tenant detail ──

  server.registerTool(
    "get_tenant_balance",
    {
      title: "Get tenant balance",
      description:
        "Quick balance check for one tenant: current balance, estimated aging buckets, and last payment. Identify the tenant by tenant_id, tenant_name, or property_name + unit_name.",
      inputSchema: { ...tenantSelector },
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const tenant = await resolveTenant(args);
        let out = `## Balance for ${tenantName(tenant)}\n\n${await tenantHeader(tenant)}\n`;
        const aging = computeAging(await svc.getTransactions(tenant.TenantID), svc.today());
        out += table(
          ["0-30 days", "31-60", "61-90", "90+", "Oldest unpaid charge", "Last payment"],
          [
            [
              money(aging.buckets.current),
              money(aging.buckets.days31to60),
              money(aging.buckets.days61to90),
              money(aging.buckets.over90),
              aging.oldestUnpaidDate ? `${aging.oldestUnpaidDate} (${aging.daysPastDue} days)` : "None",
              aging.lastPaymentDate ? `${money(aging.lastPaymentAmount)} on ${aging.lastPaymentDate}` : "None on file",
            ],
          ]
        );
        out += "\n_Aging is estimated by applying payments to the oldest charges first._\n";
        return out;
      })
  );

  server.registerTool(
    "get_tenant_ledger",
    {
      title: "Get tenant ledger",
      description:
        "Show a tenant's ledger (charges, payments, credits) with a running balance. Identify the tenant by tenant_id, tenant_name, or property_name + unit_name. If several tenants match, the tool lists them instead of guessing.",
      inputSchema: {
        ...tenantSelector,
        from_date: isoDate.optional().describe("Only show transactions on or after this date (YYYY-MM-DD)"),
        to_date: isoDate.optional().describe("Only show transactions on or before this date (YYYY-MM-DD)"),
        limit: z.number().int().min(1).max(1000).default(50).describe("Show the most recent N transactions in the range"),
      },
      annotations: READ_ONLY,
    },
    ({ from_date, to_date, limit, ...selector }) =>
      run(async () => {
        const tenant = await resolveTenant(selector);
        const [txs, chargeNames] = await Promise.all([svc.getTransactions(tenant.TenantID), svc.chargeTypeNames()]);
        let out = `## Ledger for ${tenantName(tenant)}\n\n${await tenantHeader(tenant)}\n`;
        if (!txs.length) return out + "No transactions on file.\n";

        const ledger = buildLedger(txs);
        const inRange = ledger.filter((r) => (!from_date || (r.date ?? "") >= from_date) && (!to_date || (r.date ?? "") <= to_date));
        const shown = inRange.slice(-limit);
        out += `Showing ${shown.length} of ${inRange.length} transactions${from_date || to_date ? ` between ${from_date ?? "start"} and ${to_date ?? "today"}` : ""}.\n\n`;
        out += table(
          ["Date", "Type", "Description", "Charge", "Payment/Credit", "Balance"],
          shown.map((r) => [
            r.date,
            r.type,
            truncate(
              r.tx.Comment?.trim() ||
                r.tx.Reference?.trim() ||
                (r.tx.ChargeTypeID ? chargeNames.get(r.tx.ChargeTypeID) : undefined) ||
                "",
              80
            ),
            r.signed > 0 ? money(r.signed) : "",
            r.signed < 0 ? money(-r.signed) : "",
            money(r.running),
          ])
        );
        const ending = ledger[ledger.length - 1].running;
        if (tenant.CurrentBalance !== undefined && Math.abs(ending - tenant.CurrentBalance) > 0.01) {
          out += `\n_Note: the running balance (${money(ending)}) differs from Rent Manager's current balance (${money(tenant.CurrentBalance)}). Deposits or transaction types this tool doesn't recognize may be the cause; trust Rent Manager's figure._\n`;
        }
        return out;
      })
  );

  server.registerTool(
    "get_tenant_notes",
    {
      title: "Get tenant notes",
      description: "Read the most recent history notes on a tenant's record (calls, emails, notices).",
      inputSchema: {
        ...tenantSelector,
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: READ_ONLY,
    },
    ({ limit, ...selector }) =>
      run(async () => {
        const tenant = await resolveTenant(selector);
        const notes = await svc.getNotes(tenant.TenantID);
        let out = `## Notes for ${tenantName(tenant)}\n\n${await tenantHeader(tenant)}\n`;
        if (!notes.length) return out + "No notes on file.\n";
        out += `Showing ${Math.min(limit, notes.length)} of ${notes.length}, newest first.\n\n`;
        for (const n of notes.slice(0, limit)) {
          const type = n.HistoryTypeString ?? n.HistoryType;
          out += `- **${day(n.HistoryDate ?? n.CreateDate)}**${type ? ` (${type})` : ""}: ${truncate((n.Note ?? n.NoteText ?? "").replace(/\s+/g, " ").trim(), 500) || "(empty)"}\n`;
        }
        return out;
      })
  );

  // ── Property reports ──

  server.registerTool(
    "get_delinquencies",
    {
      title: "Get delinquencies",
      description:
        "Delinquency report: tenants with a balance owed, sorted by amount, with estimated 0-30/31-60/61-90/90+ aging and last payment. Omit property_name for the whole portfolio.",
      inputSchema: {
        property_name: z.string().min(1).optional().describe("Property name or ID. Omit for all properties."),
        min_balance: z.number().min(0).default(0.01).describe("Only include balances at or above this amount"),
        include_aging: z.boolean().default(true).describe("Look up each tenant's ledger for aging (slower on large portfolios)"),
        include_past_tenants: z.boolean().default(false).describe("Also include moved-out tenants who still owe"),
        limit: z.number().int().min(1).max(1000).default(100).describe("Maximum rows to show"),
      },
      annotations: READ_ONLY,
    },
    ({ property_name, min_balance, include_aging, include_past_tenants, limit }) =>
      run(async () => {
        const property = property_name ? await svc.resolveProperty(property_name) : undefined;
        const { records, agingSkipped } = await svc.getDelinquencies({
          propertyId: property?.PropertyID,
          minBalance: Math.max(min_balance, 0.01),
          includeAging: include_aging,
          includePastTenants: include_past_tenants,
        });
        const scope = property ? property.Name : "All properties";
        if (!records.length) return `No delinquent tenants at ${scope} (balance ≥ ${money(Math.max(min_balance, 0.01))}).`;

        const total = records.reduce((s, r) => s + r.balance, 0);
        let out = `## Delinquency Report - ${scope}\n\n`;
        out += `As of ${svc.today()} | **${records.length}** tenant(s) owe **${money(total)}**\n\n`;

        const aged = records.filter((r) => r.aging);
        if (aged.length) {
          const sum = (k: keyof NonNullable<(typeof records)[number]["aging"]>["buckets"]) =>
            aged.reduce((s, r) => s + (r.aging?.buckets[k] ?? 0), 0);
          out += table(
            ["0-30 days", "31-60", "61-90", "90+"],
            [[money(sum("current")), money(sum("days31to60")), money(sum("days61to90")), money(sum("over90"))]]
          );
          out += "\n";
        }

        const shown = records.slice(0, limit);
        out += table(
          ["Tenant", "Tenant ID", "Unit", ...(property ? [] : ["Property"]), "Balance", "0-30", "31-60", "61-90", "90+", "Days Past Due", "Last Payment"],
          shown.map((r) => [
            r.tenantName + (r.tenant.IsActive === false ? " (past)" : ""),
            r.tenant.TenantID,
            r.unitName,
            ...(property ? [] : [r.propertyName]),
            money(r.balance),
            r.aging ? money(r.aging.buckets.current) : "",
            r.aging ? money(r.aging.buckets.days31to60) : "",
            r.aging ? money(r.aging.buckets.days61to90) : "",
            r.aging ? money(r.aging.buckets.over90) : "",
            r.aging ? r.aging.daysPastDue : "",
            r.aging?.lastPaymentDate ? `${money(r.aging.lastPaymentAmount)} on ${r.aging.lastPaymentDate}` : r.aging ? "None" : "",
          ])
        );
        if (records.length > shown.length) out += `\n…${records.length - shown.length} more not shown (raise limit).\n`;
        if (include_aging) {
          out += "\n_Aging is estimated by applying payments to the oldest charges first._\n";
          if (agingSkipped) out += `_Aging was skipped for the ${agingSkipped} smallest balances to limit API calls._\n`;
        }
        return out;
      })
  );

  server.registerTool(
    "get_rent_roll",
    {
      title: "Get rent roll",
      description:
        "Rent roll for one property: every active unit/lot with occupant, status (Occupied, Notice, Vacant, Pending Move-In), move-in date, monthly rent from recurring charges, other recurring charges (utilities, etc.), and balance. Set format='csv' for a spreadsheet-ready export with one column per charge type.",
      inputSchema: {
        property_name: z.string().min(1).describe("Property name or ID"),
        status: z.enum(["all", "occupied", "vacant", "notice"]).default("all").describe("Filter rows by status"),
        include_charges: z.boolean().default(true).describe("Look up recurring charges for rent amounts (one API call per occupied unit)"),
        format: z.enum(["table", "csv"]).default("table"),
      },
      annotations: READ_ONLY,
    },
    ({ property_name, status, include_charges, format }) =>
      run(async () => {
        const property = await svc.resolveProperty(property_name);
        const roll = await svc.getRentRoll(property, include_charges);
        if (!roll.rows.length) return `No active units found for ${property.Name}.`;

        const isOccupied = (r: RentRollRow) => r.status === "Occupied" || r.status === "Notice";
        const rows = roll.rows.filter((r) =>
          status === "all" ? true : status === "occupied" ? isOccupied(r) : status === "vacant" ? !isOccupied(r) : r.status === "Notice"
        );
        const chargeTypes = Object.keys(roll.chargeTotals).sort();

        if (format === "csv") {
          return csv(
            ["Unit", "Unit Type", "Status", "Tenant", "Tenant IDs", "Move In", "Move Out", "Monthly Rent", "Other Recurring", "Balance", ...chargeTypes],
            rows.map((r) => [
              r.unitName,
              r.unitType ?? "",
              r.status,
              r.tenantNames,
              r.tenants.map((t) => t.TenantID).join(" "),
              r.moveInDate ?? "",
              r.moveOutDate ?? "",
              r.rent.toFixed(2),
              r.otherRecurring.toFixed(2),
              r.balance.toFixed(2),
              ...chargeTypes.map((c) => (r.chargesByType[c] ?? 0).toFixed(2)),
            ])
          );
        }

        const all = roll.rows;
        const occupied = all.filter(isOccupied);
        const notice = all.filter((r) => r.status === "Notice").length;
        const pending = all.filter((r) => r.status === "Pending Move-In").length;
        const totalRent = occupied.reduce((s, r) => s + r.rent, 0);
        const totalOther = occupied.reduce((s, r) => s + r.otherRecurring, 0);
        const totalBalance = all.reduce((s, r) => s + r.balance, 0);

        let out = `## Rent Roll - ${property.Name}\n\n`;
        out += `As of ${svc.today()} | **${all.length}** units | Occupied **${occupied.length}** (${pct(occupied.length, all.length)})`;
        out += ` | Vacant **${all.length - occupied.length}**${pending ? ` (${pending} pending move-in)` : ""}${notice ? ` | On notice **${notice}**` : ""}\n`;
        if (roll.chargesIncluded) {
          out += `Monthly rent **${money(totalRent)}** | Avg per occupied unit **${money(occupied.length ? totalRent / occupied.length : 0)}**`;
          out += ` | Other recurring **${money(totalOther)}**`;
        }
        out += `${roll.chargesIncluded ? " | " : ""}Outstanding balances **${money(totalBalance)}**\n\n`;

        if (chargeTypes.length) {
          out += "### Monthly recurring charges by type\n\n";
          out += table(["Charge Type", "Monthly Total"], chargeTypes.map((c) => [c, money(roll.chargeTotals[c])]));
          out += "\n";
        }

        const showType = rows.some((r) => r.unitType);
        out += `### Units${status === "all" ? "" : ` (${status})`}\n\n`;
        out += table(
          ["Unit", ...(showType ? ["Type"] : []), "Tenant", "Status", "Move In", ...(roll.chargesIncluded ? ["Rent", "Other Recurring"] : []), "Balance"],
          rows.map((r) => [
            r.unitName,
            ...(showType ? [r.unitType] : []),
            r.tenantNames,
            r.status + (r.moveOutDate ? ` (out ${r.moveOutDate})` : ""),
            r.moveInDate,
            ...(roll.chargesIncluded ? [money(r.rent), money(r.otherRecurring)] : []),
            money(r.balance),
          ])
        );

        if (include_charges && !roll.chargesIncluded && occupied.length) {
          out += "\n_Recurring charges could not be read, so rent amounts are not shown._\n";
        }
        if (roll.chargesIncluded) {
          out += "\n_Rent is the sum of active recurring charges whose charge type name contains \"rent\"; everything else is listed as other recurring._\n";
        }
        if (roll.unlinked.length) {
          out += `\n_${roll.unlinked.length} current tenant(s) at this property are not linked to an active unit: ${roll.unlinked.slice(0, 10).map(tenantName).join(", ")}${roll.unlinked.length > 10 ? ", …" : ""}._\n`;
        }
        return out;
      })
  );

  server.registerTool(
    "get_portfolio_summary",
    {
      title: "Get portfolio summary",
      description:
        "One-line-per-property dashboard: units, occupied, vacant, occupancy %, units on notice, total receivables, and delinquent tenant count/amount, with portfolio totals.",
      inputSchema: {
        property_name: z.string().min(1).optional().describe("Limit to one property (name or ID). Omit for all active properties."),
      },
      annotations: READ_ONLY,
    },
    ({ property_name }) =>
      run(async () => {
        const property = property_name ? await svc.resolveProperty(property_name) : undefined;
        const rows = await svc.getPortfolioSummary(property ? [property.PropertyID] : undefined);
        if (!rows.length) return "No properties found.";
        const sum = (k: "units" | "occupied" | "vacant" | "notice" | "receivables" | "delinquentCount" | "delinquentAmount") =>
          rows.reduce((s, r) => s + r[k], 0);

        const body = rows.map((r) => [
          r.property.Name,
          r.units,
          r.occupied,
          r.vacant,
          pct(r.occupied, r.units),
          r.notice,
          money(r.receivables),
          r.delinquentCount,
          money(r.delinquentAmount),
        ]);
        if (rows.length > 1) {
          body.push([
            "**Total**",
            sum("units"),
            sum("occupied"),
            sum("vacant"),
            pct(sum("occupied"), sum("units")),
            sum("notice"),
            money(sum("receivables")),
            sum("delinquentCount"),
            money(sum("delinquentAmount")),
          ]);
        }
        return (
          `## Portfolio Summary\n\nAs of ${svc.today()}\n\n` +
          table(["Property", "Units", "Occupied", "Vacant", "Occupancy", "On Notice", "Net Receivables", "Delinquent Tenants", "Delinquent $"], body) +
          "\n_Net receivables subtract prepaid (credit) balances; Delinquent $ counts only tenants who owe._\n"
        );
      })
  );

  // ── Work orders ──

  server.registerTool(
    "get_work_orders",
    {
      title: "Get work orders",
      description: "List Service Manager work orders (maintenance issues), open ones by default, newest first.",
      inputSchema: {
        property_name: z.string().min(1).optional().describe("Property name or ID. Omit for all properties."),
        include_closed: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: READ_ONLY,
    },
    ({ property_name, include_closed, limit }) =>
      run(async () => {
        const property = property_name ? await svc.resolveProperty(property_name) : undefined;
        const issues = await svc.getWorkOrders({ propertyId: property?.PropertyID, includeClosed: include_closed });
        const scope = property ? ` at ${property.Name}` : "";
        if (!issues.length) return `No ${include_closed ? "" : "open "}work orders${scope}.`;

        const properties = new Map((await svc.listProperties(true)).map((p) => [p.PropertyID, p.Name]));
        const today = svc.today();
        const shown = issues.slice(0, limit);
        return (
          `## ${include_closed ? "Work Orders" : "Open Work Orders"}${scope}\n\nShowing ${shown.length} of ${issues.length}, newest first.\n\n` +
          table(
            ["ID", "Created", "Age (days)", "Title", "Status", "Priority", "Category", ...(property ? [] : ["Property"]), "Unit"],
            shown.map((i) => {
              const created = day(i.CreateDate);
              const age = /^\d{4}-\d{2}-\d{2}$/.test(created)
                ? Math.max(0, Math.round((Date.parse(today) - Date.parse(created)) / 86_400_000))
                : "";
              return [
                i.ServiceManagerIssueID,
                created,
                age,
                truncate(i.Title ?? "", 70),
                i.Status?.Name ?? (i.IsClosed ? "Closed" : ""),
                i.Priority?.Name,
                i.Category?.Name,
                ...(property ? [] : [i.PropertyID ? properties.get(i.PropertyID) : ""]),
                i.Unit ? unitLabel(i.Unit) : "",
              ];
            })
          )
        );
      })
  );

  // ── Raw read access ──

  server.registerTool(
    "rm_api_get",
    {
      title: "Rent Manager API GET",
      description:
        "Read-only escape hatch: GET any Rent Manager WAPI12 resource and return raw JSON. Use it for data the other tools don't cover, or to discover field names " +
        "(e.g. path 'Tenants/123/Leases', 'HistoryCategories', 'ServiceManagerCategories', 'ServiceManagerPriorities', 'ChargeTypes'). " +
        "Filters use Rent Manager syntax 'Field,operator,value' joined by ';' (operators: eq, ne, gt, ge, lt, le, ct, sw, ew, in, bt).",
      inputSchema: {
        path: z.string().min(1).describe("Resource path, e.g. 'Units' or 'Tenants/123/RecurringCharges'"),
        filters: z.string().optional().describe("e.g. 'PropertyID,eq,3;IsActive,eq,true'"),
        fields: z.string().optional().describe("Comma-separated field list"),
        embed: z.string().optional().describe("Comma-separated related objects to embed"),
        orderby: z.string().optional().describe("e.g. 'Name' or 'CreateDate DESC'"),
        pagesize: z.number().int().min(1).max(1000).default(25),
        pagenumber: z.number().int().min(1).default(1),
      },
      annotations: READ_ONLY,
    },
    ({ path, filters, fields, embed, orderby, pagesize, pagenumber }) =>
      run(async () => {
        const clean = path.trim().replace(/^\/+/, "").replace(/\?.*$/, "");
        if (!/^[A-Za-z][A-Za-z0-9_/-]*$/.test(clean) || clean.includes("..")) {
          throw new UserFacingError(`Invalid path "${path}". Use a resource path like "Units" or "Tenants/123/Leases".`);
        }
        if (/^authentication/i.test(clean)) throw new UserFacingError("Authentication endpoints are not available through this tool.");
        const split = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
        const data = await svc.client.get<unknown>(`/${clean}`, {
          filters: filters?.trim() ? [filters.trim()] : undefined,
          fields: split(fields),
          embed: split(embed),
          orderby: orderby?.trim() ? [orderby.trim()] : undefined,
          pagesize,
          pagenumber,
        });
        const count = Array.isArray(data) ? `${data.length} record(s), page ${pagenumber}` : "1 record";
        return `GET /${clean} → ${count}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
      })
  );

  if (svc.config.readOnly) return;

  // ── Write tools (disabled when RM_READ_ONLY=true) ──

  server.registerTool(
    "add_tenant_note",
    {
      title: "Add tenant note",
      description:
        "Write a history note to one tenant's record (call log, notice served, payment promise). Only saves when exactly one tenant matches; otherwise lists the matches so you can retry with tenant_id. Confirm the tenant with the user before calling.",
      inputSchema: {
        ...tenantSelector,
        note: z.string().trim().min(1).max(8000).describe("Note text to save"),
        category_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("HistoryCategoryID, if your Rent Manager requires a note category. Look IDs up with rm_api_get path 'HistoryCategories'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ note, category_id, ...selector }) =>
      run(async () => {
        const tenant = await resolveTenant(selector);
        const saved = await svc.addNote(tenant.TenantID, note, category_id);
        const label = (await svc.labelTenants([tenant])).get(tenant.TenantID);
        return [
          `Note saved to ${tenantName(tenant)}'s record.`,
          `- Tenant ID: ${tenant.TenantID} | Unit: ${label?.unitName ?? "-"} | Property: ${label?.propertyName ?? "-"}`,
          saved.historyId ? `- History ID: ${saved.historyId}` : `- Saved via ${saved.endpoint}`,
          "",
          `> ${truncate(note, 300).replace(/\n/g, "\n> ")}`,
        ].join("\n");
      })
  );

  server.registerTool(
    "create_work_order",
    {
      title: "Create work order",
      description:
        "Create a Service Manager work order (maintenance issue) for a property, optionally tied to a unit and tenant. Confirm details with the user before calling. " +
        "Category, priority and status IDs can be looked up with rm_api_get on 'ServiceManagerCategories', 'ServiceManagerPriorities', 'ServiceManagerStatuses'.",
      inputSchema: {
        title: z.string().trim().min(1).max(200).describe("Short summary, e.g. 'Water leak under home'"),
        description: z.string().trim().min(1).max(8000).describe("Full details of the issue"),
        property_name: z.string().min(1).describe("Property name or ID"),
        unit_name: z.string().min(1).optional().describe("Unit/lot name or number"),
        tenant_id: z.number().int().positive().optional().describe("TenantID to link (find it with search_tenants)"),
        category_id: z.number().int().positive().optional(),
        priority_id: z.number().int().positive().optional(),
        status_id: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ title, description, property_name, unit_name, tenant_id, category_id, priority_id, status_id }) =>
      run(async () => {
        const property = await svc.resolveProperty(property_name);
        const unit = unit_name ? await svc.resolveUnit(property, unit_name) : undefined;
        const created = await svc.createWorkOrder({
          title,
          description,
          propertyId: property.PropertyID,
          unitId: unit?.UnitID,
          tenantId: tenant_id,
          categoryId: category_id,
          priorityId: priority_id,
          statusId: status_id,
        });
        return [
          "Work order created.",
          created?.ServiceManagerIssueID ? `- Issue ID: ${created.ServiceManagerIssueID}` : "- Rent Manager did not return an issue ID.",
          `- Property: ${property.Name}${unit ? ` | Unit: ${unitLabel(unit)}` : ""}${tenant_id ? ` | Tenant ID: ${tenant_id}` : ""}`,
          `- Title: ${title}`,
        ].join("\n");
      })
  );
}
