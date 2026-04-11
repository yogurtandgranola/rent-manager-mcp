# Rent Manager MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io/) server that connects Claude to **Rent Manager Online (RMO)** via their REST API. Query and update Rent Manager data conversationally through Claude.

## Tools Included

| Tool | Description |
|------|-------------|
| `get_delinquencies` | Pull delinquency data by property name |
| `get_tenant_ledger` | Pull tenant ledger / payment history by name or unit |
| `add_tenant_note` | Write notes to a tenant's record |
| `get_rent_roll` | Pull current rent roll for a property |

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
RM_API_BASE_URL=https://yourcompany.rentmanager.com/api

# Option A: API Token (preferred)
RM_API_TOKEN=your-api-token-here

# Option B: Username/Password
RM_USERNAME=your-username
RM_PASSWORD=your-password

# Your location ID
RM_LOCATION_ID=1
```

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
      "args": ["/absolute/path/to/rent-manager-mcp-server/dist/index.js"],
      "env": {
        "RM_API_BASE_URL": "https://yourcompany.rentmanager.com/api",
        "RM_API_TOKEN": "your-api-token-here",
        "RM_LOCATION_ID": "1"
      }
    }
  }
}
```

> **Note:** Replace `/absolute/path/to/rent-manager-mcp-server` with the actual path where you cloned this repo. You can pass credentials via `env` in the config (shown above) or via a `.env` file in the project root.

### 5. Restart Claude Desktop

After saving the config, restart Claude Desktop. You should see the Rent Manager tools available in the tools menu.

## Usage Examples

Once connected, you can ask Claude things like:

- "Show me delinquencies at Sunflower Estates"
- "Pull the ledger for John Smith"
- "What's the rent roll for Oak Park Apartments?"
- "Add a note to the tenant in unit 204 at Maple Ridge: Called about maintenance request for leaky faucet, submitted work order #1234"

## Development

Run in dev mode (no build step needed):

```bash
npm run dev
```

## Next Tools to Build

Once the core 4 tools are working, here are the next tools worth adding:

1. **`search_tenants`** — Search tenants by name, email, phone, or status across all properties
2. **`get_work_orders`** — Pull open maintenance/work orders by property or unit
3. **`create_work_order`** — Create a new maintenance work order from a conversation
4. **`get_lease_details`** — Pull lease terms, renewal dates, and rent escalation schedules
5. **`get_vacancy_report`** — Show all vacant units with market rent and days vacant
6. **`record_payment`** — Record a payment against a tenant's balance (with confirmation safeguards)
7. **`get_owner_statement`** — Pull owner distribution/statement data for a property
8. **`get_expiring_leases`** — Show leases expiring within a date range for renewal planning
9. **`get_tenant_balance`** — Quick balance check for a specific tenant without full ledger
10. **`get_property_summary`** — High-level dashboard: occupancy, revenue, delinquency totals for a property
