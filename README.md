# Rent Manager MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that connects Claude to **Rent Manager 12** through the Rent Manager Web API (WAPI12). Ask Claude for rent rolls, delinquency, ledgers and portfolio occupancy, and have it log tenant notes or open work orders.

## Tools

| Tool | What it does | Writes? |
|------|--------------|---------|
| `test_connection` | Logs in and confirms the API user can read data | |
| `list_properties` | Properties (communities) with their IDs | |
| `get_portfolio_summary` | Per-property units, occupancy %, units on notice, receivables, delinquent count and dollars, with portfolio totals | |
| `get_rent_roll` | Every active lot/unit with occupant, status (Occupied, Notice, Vacant, Pending Move-In), move-in date, rent, other recurring charges (water, sewer, trash...) and balance. `format: "csv"` returns a spreadsheet-ready export with one column per charge type | |
| `get_delinquencies` | Tenants who owe, sorted by balance, with estimated 0-30 / 31-60 / 61-90 / 90+ aging and last payment | |
| `search_tenants` | Find tenants by name, email or ID | |
| `get_tenant_balance` | One tenant's balance, aging and last payment | |
| `get_tenant_ledger` | Charges, payments and credits with a running balance, filterable by date | |
| `get_tenant_notes` | Recent history notes on a tenant | |
| `get_work_orders` | Open (or all) Service Manager issues, newest first | |
| `rm_api_get` | Read-only access to any WAPI12 resource as raw JSON, for anything the other tools don't cover | |
| `add_tenant_note` | Adds a history note to one tenant | Yes |
| `create_work_order` | Opens a Service Manager issue for a property, lot and tenant | Yes |

Tenant tools accept a `tenant_id`, a `tenant_name`, or a `property_name` + `unit_name` ("Lot 12", "12" and "012" all match the same lot). Property names can be partial or the property ID.

### Safety

- **No guessing.** If a name matches several tenants or properties, the tool lists them with IDs and does nothing else. Notes are never written to "the first match".
- **Writes are never retried.** Reads retry on timeouts and rate limits; writes don't, so a note or work order can't be created twice.
- **Read-only mode.** Set `RM_READ_ONLY=true` to remove `add_tenant_note` and `create_work_order` entirely.
- Credentials stay on your machine and are only sent to your Rent Manager API host.

## Setup

### 1. Get API access

Rent Manager has to enable WAPI12 for your account. You need:

- Your **corporate ID**: the `yourcompany` part of `https://yourcompany.api.rentmanager.com`
- A dedicated **API user** (username and password) with access to the properties you want to query
- The **location ID** to log in to (usually `1`)

### 2. Install and build

Requires Node.js 20.12 or newer.

```bash
npm install     # also builds dist/
```

### 3. Configure

Either copy `.env.example` to `.env` and fill it in, or pass the same variables in your MCP client config (shown below). Values in the client config take priority.

| Variable | Required | Notes |
|----------|----------|-------|
| `RM_CORP_ID` | Yes, or `RM_API_BASE_URL` | API URL becomes `https://{RM_CORP_ID}.api.rentmanager.com` |
| `RM_API_BASE_URL` | | Full API URL, only for a non-standard host |
| `RM_USERNAME`, `RM_PASSWORD` | Yes, or `RM_API_TOKEN` | API user credentials. The server logs in again automatically when the session token expires |
| `RM_LOCATION_ID` | | Defaults to `1` |
| `RM_API_TOKEN` | | A pre-issued token, used instead of logging in |
| `RM_READ_ONLY` | | `true` hides the write tools |
| `RM_NOTE_CATEGORY_ID` | | Default `HistoryCategoryID` for new notes, if your setup requires a category |
| `RM_TIMEOUT_SECONDS` | | Per-request timeout, default `30` |

### 4. Connect it to Claude

**Claude Desktop:** add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop.

```json
{
  "mcpServers": {
    "rent-manager": {
      "command": "node",
      "args": ["/absolute/path/to/rent-manager-mcp/dist/index.js"],
      "env": {
        "RM_CORP_ID": "yourcompany",
        "RM_USERNAME": "api-user",
        "RM_PASSWORD": "your-password",
        "RM_LOCATION_ID": "1"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add rent-manager \
  -e RM_CORP_ID=yourcompany -e RM_USERNAME=api-user -e RM_PASSWORD=your-password \
  -- node /absolute/path/to/rent-manager-mcp/dist/index.js
```

### 5. Check the connection

Ask Claude to "test the Rent Manager connection". You should see your API host, location and property count.

## First-run checklist

Rent Manager instances vary by version and configuration. These points were built from Rent Manager's public SDKs but should be confirmed once against your account:

1. **Tenant notes.** Run `add_tenant_note` once on a test tenant and confirm it appears on the tenant's History tab. The server posts to `/Tenants/{id}/History` and, only if that route doesn't exist, to `/Tenants/HistoryNotes`. If Rent Manager says a category is required, look up IDs with `rm_api_get` on `HistoryCategories` and set `RM_NOTE_CATEGORY_ID`.
2. **Rent amounts.** The rent roll counts a recurring charge as rent when its charge type name contains "rent" (e.g. "Lot Rent", "Home Rent"). Everything else (utilities, fees) shows as other recurring. Compare one property against Rent Manager's own rent roll report.
3. **Aging.** Rent Manager allocates each payment to specific charges; this server estimates aging by applying payments to the oldest charges first. Totals match the tenant's balance, but bucket splits can differ slightly from Rent Manager's aging report.

If a tool reports a missing field or an API error, `rm_api_get` shows exactly what your instance returns, e.g. path `Tenants`, pagesize `1`.

## Example requests

- "Give me a portfolio summary."
- "Rent roll for Sunflower Estates as CSV."
- "Who owes more than $500 at Oak Park, and how far behind are they?"
- "Pull the ledger for lot 14 at Sunflower since July 1."
- "Add a note to Jane Doe's account: called 10/26, promised to pay $300 Friday."
- "Open a work order at Sunflower lot 22: water leak under the home, tenant reported this morning."

## Development

```bash
npm run dev        # run from source with tsx
npm run check      # typecheck + tests
npm run build      # compile to dist/
```

Tests run against a mocked Rent Manager API and don't need credentials.

| Path | Contents |
|------|----------|
| `src/index.ts` | Entry point: loads `.env`, config, starts the stdio server |
| `src/config.ts` | Environment variable parsing |
| `src/rent-manager-client.ts` | HTTP client: login, token handling, RQL filters, paging, retries, errors |
| `src/services.ts` | Rent Manager logic: name matching, aging, occupancy, rent roll |
| `src/tools.ts` | MCP tool definitions and output formatting |

### Possible next tools

- `get_expiring_leases`: needs lease term fields, which vary by Rent Manager setup
- `get_owner_statement`: owner distributions per property
- `record_payment`: deliberately left out; posting money should stay in Rent Manager until there is a confirmation flow
