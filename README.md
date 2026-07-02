# Rent Manager MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that turns Claude into a full-featured front end for **Rent Manager Online (RMO)**: operations data, tenants, work orders, financial statements, **every report in your RM instance**, and shareable HTML dashboards.

## Tools Included (25)

### Operations / read

| Tool | Description |
|------|-------------|
| `list_properties` | List all properties with addresses and unit counts |
| `get_property_summary` | Portfolio overview: occupancy, scheduled rent, delinquency per property |
| `get_delinquencies` | Delinquency report by property, with optional minimum-balance filter |
| `get_rent_roll` | Current rent roll for a property |
| `get_vacancy_report` | All vacant units with market rent and days vacant |
| `get_expiring_leases` | Leases expiring within N days (default 90) for renewal planning |
| `search_tenants` | Search tenants by name, email, phone, status, or property |
| `get_tenant_ledger` | Tenant ledger / payment history by name or unit |
| `get_tenant_balance` | Quick balance check without pulling the full ledger |
| `get_work_orders` | Open (or all) maintenance work orders by property |
| `get_prospects` | Leasing prospects/leads, per property or portfolio-wide |

### Reports engine — pull ANY Rent Manager report

| Tool | Description |
|------|-------------|
| `list_reports` | Every report available in your RM instance (built-in **and** custom) |
| `get_report_info` | The parameters a report accepts, before you run it |
| `run_report` | Run any report by name/ID with arbitrary parameters — inline data, PDF, or Excel |

### Financial statements

| Tool | Description |
|------|-------------|
| `get_profit_and_loss` | P&L / income statement per property or portfolio, any date range |
| `get_balance_sheet` | Balance sheet as of any date |
| `get_cash_flow` | Cash-flow statement, any date range |
| `get_owner_statement` | Owner statement by owner and/or property (PDF-ready) |
| `get_chart_of_accounts` | GL chart of accounts |
| `list_owners` | Property owners with contact info |
| `list_vendors` | Vendors/suppliers |
| `get_bills` | Accounts-payable bills (unpaid by default) |

### Write

| Tool | Description |
|------|-------------|
| `add_tenant_note` | Write a note to a tenant's record |
| `create_work_order` | Create a maintenance work order, linked to a tenant/unit |

### Dashboards

| Tool | Description |
|------|-------------|
| `generate_dashboard` | Build a shareable, self-contained HTML dashboard (see below) |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` and fill in your Rent Manager credentials:

```env
# Your Rent Manager API base URL
RM_API_BASE_URL=https://yourcompany.api.rentmanager.com

# Option A: API Token (preferred)
RM_API_TOKEN=your-api-token-here

# Option B: Username/Password
RM_USERNAME=your-username
RM_PASSWORD=your-password

# Your location ID
RM_LOCATION_ID=1
```

The `.env` file is loaded automatically (no extra dependency), and values passed via the MCP client's `env` block always take precedence.

### 3. Build

```bash
npm run build
```

### 4. Add to Claude Desktop

Add this to your `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "rent-manager": {
      "command": "node",
      "args": ["/absolute/path/to/rent-manager-mcp/dist/index.js"],
      "env": {
        "RM_API_BASE_URL": "https://yourcompany.api.rentmanager.com",
        "RM_API_TOKEN": "your-api-token-here",
        "RM_LOCATION_ID": "1"
      }
    }
  }
}
```

> **Note:** Replace `/absolute/path/to/rent-manager-mcp` with the actual path where you cloned this repo. You can pass credentials via `env` in the config (shown above) or via a `.env` file in the project root.

### 5. Restart Claude Desktop

After saving the config, restart Claude Desktop. You should see the Rent Manager tools available in the tools menu.

## Usage Examples

Once connected, you can ask Claude things like:

- "Give me a portfolio summary"
- "Show me delinquencies at Sunflower Estates over $500"
- "Which leases expire in the next 60 days?"
- "What units are vacant and how long have they been sitting?"
- "Pull the ledger for John Smith"
- "Find the tenant with phone number ending in 4821"
- "Add a note to the tenant in unit 204 at Maple Ridge: Called about maintenance request"
- "Create a work order for unit 12B at Maple Ridge: garbage disposal jammed"
- "Generate a dashboard I can send to the team"
- "Pull the P&L for Oak Park for Q2 and compare it to the portfolio"
- "Get me the balance sheet as of June 30"
- "What reports are available for receivables?" → then "Run the aged receivables report"
- "Pull the owner statement for the Hendersons year-to-date as a PDF"
- "Which bills are unpaid right now?"

## Pulling P&Ls and every other report

Rent Manager exposes **every report in your instance** — built-in and custom — through its report API, and this server surfaces all of them:

1. **`list_reports`** shows the whole catalog (filter with `search: "profit"`, `"owner"`, `"aged"`, …).
2. **`get_report_info`** shows the exact parameters a report accepts.
3. **`run_report`** runs it — inline data tables by default, or `format: "pdf"` / `"excel"` for a downloadable, send-ready file.

The common financial statements (P&L, balance sheet, cash flow, owner statements) also have first-class tools with sensible defaults (year-to-date, whole portfolio) so you can just ask for them by name. All date parameters use `MM/DD/YYYY`.

> **Note:** report names and parameter names vary slightly between Rent Manager versions and configurations. The financial tools try the common name variants automatically, and every tool falls back gracefully — if a run fails, `get_report_info` shows the exact parameters your instance expects, and `extra_parameters` lets you pass anything instance-specific (e.g. accounting basis).

## Team Dashboards

The dashboard generator produces a **single self-contained HTML file** — no server, no login, no Rent Manager seat needed to view it. Email it, drop it in Slack, or host it on a shared drive; anyone can open it in a browser.

It includes:

- Stat tiles: occupancy, scheduled monthly rent, outstanding balances, vacant units, upcoming lease expirations
- Occupancy by property (occupied vs. vacant)
- Delinquent balance by property and delinquency aging (0–30 / 31–60 / 61–90 / 90+ days)
- Renewal outreach list (leases expiring ≤ 90 days, ≤ 30 flagged)
- Vacant-unit list with market rent and days vacant

Every chart has hover tooltips and a table view, supports light/dark mode automatically, and prints cleanly to PDF.

### Generate via Claude

> "Generate a dashboard for the whole portfolio and save it to reports/weekly.html"

### Generate from the command line (no Claude needed)

```bash
npm run dashboard                              # full portfolio → rent-dashboard-YYYY-MM-DD.html
npm run dashboard -- --property "Oak Park"     # one property
npm run dashboard -- --out reports/weekly.html # custom output path
npm run dashboard:demo                         # sample data, no credentials needed
```

Because it's a plain CLI, you can schedule it (cron, Task Scheduler) to publish a fresh dashboard every Monday morning:

```cron
0 7 * * 1 cd /path/to/rent-manager-mcp && npm run dashboard -- --out /shared/dashboards/weekly.html
```

## Development

Run in dev mode (no build step needed):

```bash
npm run dev
```

## Ideas for Next Steps

1. **`record_payment`** — Record a payment against a tenant's balance (with confirmation safeguards)
2. **`get_lease_details`** — Full lease terms, renewal options, and rent escalation schedules
3. **Trend history** — persist each dashboard snapshot and chart occupancy/delinquency over time
4. **Email delivery** — pipe the generated dashboard into a scheduled email to the team
5. **Financial dashboard** — fold P&L trends into the shareable HTML dashboard
