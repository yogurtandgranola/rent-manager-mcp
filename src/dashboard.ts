import type { PortfolioSnapshot } from "./types.js";

// Chart geometry
const BAR_H = 18;
const ROW_H = 34;
const LABEL_W = 195;
const VALUE_W = 80;
const CHART_W = 720;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function moneyCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `$${(n / 1_000).toFixed(0)}K`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return money(n);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Rect with only the right corners rounded — data-end rounded, baseline square. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return `M${x},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${w - rr} z`;
}

interface HRow {
  label: string;
  segments: Array<{ value: number; cssVar: string; name: string }>;
  valueLabel: string;
  tip: string;
}

/** Horizontal bar chart (single-series or stacked) as inline SVG. */
function hBarChart(rows: HRow[], maxValue: number): string {
  const plotW = CHART_W - LABEL_W - VALUE_W;
  const height = rows.length * ROW_H + 8;
  const scale = (v: number) => (maxValue > 0 ? (v / maxValue) * plotW : 0);

  let svg = `<svg viewBox="0 0 ${CHART_W} ${height}" role="img" style="width:100%;height:auto;display:block">`;

  rows.forEach((row, i) => {
    const y = i * ROW_H + (ROW_H - BAR_H) / 2;
    const cy = i * ROW_H + ROW_H / 2;

    svg += `<text x="${LABEL_W - 10}" y="${cy}" text-anchor="end" dominant-baseline="central" class="axis-label">${esc(row.label)}</text>`;

    let x = LABEL_W;
    const drawn = row.segments.filter((s) => s.value > 0);
    drawn.forEach((seg, si) => {
      const w = Math.max(scale(seg.value) - (si < drawn.length - 1 ? 2 : 0), 1.5);
      const isLast = si === drawn.length - 1;
      if (isLast) {
        svg += `<path d="${barPath(x, y, w, BAR_H, 4)}" fill="var(${seg.cssVar})"/>`;
      } else {
        svg += `<rect x="${x}" y="${y}" width="${w}" height="${BAR_H}" fill="var(${seg.cssVar})"/>`;
      }
      x += scale(seg.value); // gap is carved out of the segment, not added to x
    });

    svg += `<text x="${x + 8}" y="${cy}" dominant-baseline="central" class="value-label">${esc(row.valueLabel)}</text>`;
    // Full-row hover target so tooltips don't require pinpoint aim
    svg += `<rect x="0" y="${i * ROW_H}" width="${CHART_W}" height="${ROW_H}" fill="transparent" class="hover-target" data-tip="${esc(row.tip)}"/>`;
  });

  svg += `</svg>`;
  return svg;
}

interface ChartCard {
  id: string;
  title: string;
  subtitle?: string;
  legend?: Array<{ name: string; cssVar: string }>;
  chartHtml: string;
  tableHead: string[];
  tableRows: string[][];
  emptyMessage?: string;
  isEmpty?: boolean;
}

function renderCard(card: ChartCard): string {
  const legend = card.legend
    ? `<div class="legend">${card.legend
        .map((l) => `<span class="legend-item"><span class="swatch" style="background:var(${l.cssVar})"></span>${esc(l.name)}</span>`)
        .join("")}</div>`
    : "";

  const table = `<table><thead><tr>${card.tableHead.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${card.tableRows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? "" : "num"}">${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

  const body = card.isEmpty
    ? `<p class="empty">${esc(card.emptyMessage ?? "No data")}</p>`
    : `<div class="chart-view" id="${card.id}-chart">${card.chartHtml}</div>
       <div class="table-view" id="${card.id}-table" hidden>${table}</div>`;

  const toggle = card.isEmpty
    ? ""
    : `<button class="toggle" data-card="${card.id}" aria-pressed="false">Table</button>`;

  return `<section class="card">
    <header class="card-head">
      <div>
        <h2>${esc(card.title)}</h2>
        ${card.subtitle ? `<p class="subtitle">${esc(card.subtitle)}</p>` : ""}
      </div>
      <div class="card-actions">${legend}${toggle}</div>
    </header>
    ${body}
  </section>`;
}

function statTile(label: string, value: string, detail?: string, tone?: "good" | "critical"): string {
  return `<div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value${tone ? ` tone-${tone}` : ""}">${esc(value)}</div>
    ${detail ? `<div class="tile-detail">${esc(detail)}</div>` : ""}
  </div>`;
}

export function renderDashboardHTML(snapshot: PortfolioSnapshot, scopeLabel?: string): string {
  const props = snapshot.properties;
  const totalUnits = props.reduce((s, p) => s + p.TotalUnits, 0);
  const occupiedUnits = props.reduce((s, p) => s + p.OccupiedUnits, 0);
  const occupancy = totalUnits ? (occupiedUnits / totalUnits) * 100 : 0;
  const scheduledRent = props.reduce((s, p) => s + p.ScheduledMonthlyRent, 0);
  const delinquentTotal = snapshot.delinquencies.reduce((s, d) => s + d.Balance, 0);
  const expiring60 = snapshot.expiringLeases.filter((l) => l.DaysUntilExpiration <= 60).length;

  // ── Occupancy by property (stacked: occupied + vacant) ──
  const occRows: HRow[] = props.map((p) => ({
    label: p.PropertyName,
    segments: [
      { value: p.OccupiedUnits, cssVar: "--series-1", name: "Occupied" },
      { value: p.VacantUnits, cssVar: "--series-muted", name: "Vacant" },
    ],
    valueLabel: `${p.OccupancyRate.toFixed(0)}%`,
    tip: `${p.PropertyName}: ${p.OccupiedUnits} occupied, ${p.VacantUnits} vacant (${p.OccupancyRate.toFixed(1)}%)`,
  }));
  const occMax = Math.max(...props.map((p) => p.TotalUnits), 1);

  const occCard = renderCard({
    id: "occupancy",
    title: "Occupancy by property",
    subtitle: "Bar length = total units; % label = occupancy rate",
    legend: [
      { name: "Occupied", cssVar: "--series-1" },
      { name: "Vacant", cssVar: "--series-muted" },
    ],
    chartHtml: hBarChart(occRows, occMax),
    tableHead: ["Property", "Units", "Occupied", "Vacant", "Occupancy", "Scheduled rent"],
    tableRows: props.map((p) => [
      p.PropertyName,
      String(p.TotalUnits),
      String(p.OccupiedUnits),
      String(p.VacantUnits),
      `${p.OccupancyRate.toFixed(1)}%`,
      money(p.ScheduledMonthlyRent),
    ]),
    isEmpty: props.length === 0,
    emptyMessage: "No properties found",
  });

  // ── Delinquent balance by property (single series) ──
  const delinquentProps = props
    .filter((p) => p.DelinquentBalance > 0)
    .sort((a, b) => b.DelinquentBalance - a.DelinquentBalance);
  const delRows: HRow[] = delinquentProps.map((p) => ({
    label: p.PropertyName,
    segments: [{ value: p.DelinquentBalance, cssVar: "--series-1", name: "Balance" }],
    valueLabel: moneyCompact(p.DelinquentBalance),
    tip: `${p.PropertyName}: ${money(p.DelinquentBalance)} across ${p.DelinquentTenants} tenant(s)`,
  }));
  const delMax = Math.max(...delinquentProps.map((p) => p.DelinquentBalance), 1);

  const delByPropCard = renderCard({
    id: "delinquency-prop",
    title: "Delinquent balance by property",
    chartHtml: hBarChart(delRows, delMax),
    tableHead: ["Property", "Delinquent tenants", "Balance"],
    tableRows: delinquentProps.map((p) => [
      p.PropertyName,
      String(p.DelinquentTenants),
      money(p.DelinquentBalance),
    ]),
    isEmpty: delinquentProps.length === 0,
    emptyMessage: "No delinquent balances — nothing owed. 🎉",
  });

  // ── Delinquency aging (ordinal ramp) or top-tenant fallback ──
  const hasAging = snapshot.delinquencies.some((d) => d.DaysPastDue > 0);
  let agingCard: string;
  if (hasAging) {
    const buckets = [
      { name: "0–30 days", cssVar: "--ord-1", min: 0, max: 30 },
      { name: "31–60 days", cssVar: "--ord-2", min: 31, max: 60 },
      { name: "61–90 days", cssVar: "--ord-3", min: 61, max: 90 },
      { name: "90+ days", cssVar: "--ord-4", min: 91, max: Infinity },
    ].map((b) => {
      const records = snapshot.delinquencies.filter(
        (d) => d.DaysPastDue >= b.min && d.DaysPastDue <= b.max
      );
      return { ...b, total: records.reduce((s, d) => s + d.Balance, 0), count: records.length };
    });
    const agingMax = Math.max(...buckets.map((b) => b.total), 1);
    const agingRows: HRow[] = buckets.map((b) => ({
      label: b.name,
      segments: [{ value: b.total, cssVar: b.cssVar, name: b.name }],
      valueLabel: b.total > 0 ? moneyCompact(b.total) : "—",
      tip: `${b.name}: ${money(b.total)} across ${b.count} tenant(s)`,
    }));
    agingCard = renderCard({
      id: "aging",
      title: "Delinquency aging",
      subtitle: "Outstanding balance by days past due",
      chartHtml: hBarChart(agingRows, agingMax),
      tableHead: ["Age", "Tenants", "Balance"],
      tableRows: buckets.map((b) => [b.name, String(b.count), money(b.total)]),
    });
  } else {
    const top = snapshot.delinquencies.slice(0, 10);
    const topMax = Math.max(...top.map((d) => d.Balance), 1);
    const topRows: HRow[] = top.map((d) => ({
      label: d.TenantName,
      segments: [{ value: d.Balance, cssVar: "--series-1", name: "Balance" }],
      valueLabel: moneyCompact(d.Balance),
      tip: `${d.TenantName} — Unit ${d.UnitName} at ${d.PropertyName}: ${money(d.Balance)}`,
    }));
    agingCard = renderCard({
      id: "aging",
      title: "Top delinquent tenants",
      subtitle: top.length === 10 ? "Ten largest outstanding balances" : undefined,
      chartHtml: hBarChart(topRows, topMax),
      tableHead: ["Tenant", "Unit", "Property", "Balance"],
      tableRows: top.map((d) => [d.TenantName, d.UnitName, d.PropertyName, money(d.Balance)]),
      isEmpty: top.length === 0,
      emptyMessage: "No delinquent tenants",
    });
  }

  // ── Expiring leases — a plain table; no chart form fits a list of dates
  // better than the list itself ──
  const leaseTable =
    snapshot.expiringLeases.length === 0
      ? `<p class="empty">No leases expiring in the next 90 days</p>`
      : `<table><thead><tr><th>Tenant</th><th>Unit</th><th>Property</th><th>Lease ends</th><th class="num">Days left</th><th class="num">Rent</th></tr></thead><tbody>${snapshot.expiringLeases
          .map(
            (l) =>
              `<tr><td>${esc(l.TenantName)}</td><td>${esc(l.UnitName)}</td><td>${esc(l.PropertyName)}</td><td>${esc(fmtDate(l.LeaseEnd))}</td><td class="num${l.DaysUntilExpiration <= 30 ? " urgent" : ""}">${l.DaysUntilExpiration}</td><td class="num">${l.MonthlyRent != null ? money(l.MonthlyRent) : "—"}</td></tr>`
          )
          .join("")}</tbody></table>`;
  const leaseCardHtml = `<section class="card">
    <header class="card-head"><div><h2>Leases expiring in the next 90 days</h2>
    <p class="subtitle">Renewal outreach list — days left ≤ 30 flagged</p></div></header>
    ${leaseTable}
  </section>`;

  // ── Vacant units table ──
  const vacantTable =
    snapshot.vacantUnits.length === 0
      ? `<p class="empty">No vacant units 🎉</p>`
      : `<table><thead><tr><th>Unit</th><th>Property</th><th class="num">Market rent</th><th>Last move-out</th><th class="num">Days vacant</th></tr></thead><tbody>${snapshot.vacantUnits
          .map(
            (v) =>
              `<tr><td>${esc(v.UnitName)}</td><td>${esc(v.PropertyName)}</td><td class="num">${money(v.MarketRent)}</td><td>${esc(fmtDate(v.LastMoveOutDate))}</td><td class="num">${v.DaysVacant ?? "—"}</td></tr>`
          )
          .join("")}</tbody></table>`;
  const lostRent = snapshot.vacantUnits.reduce((s, v) => s + v.MarketRent, 0);
  const vacantCardHtml = `<section class="card">
    <header class="card-head"><div><h2>Vacant units</h2>
    <p class="subtitle">${snapshot.vacantUnits.length} vacant · ${money(lostRent)}/mo in unrealized market rent</p></div></header>
    ${vacantTable}
  </section>`;

  const generated = new Date(snapshot.generatedAt);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portfolio Dashboard${scopeLabel ? ` — ${esc(scopeLabel)}` : ""}</title>
<style>
  :root {
    --page: #f9f9f7;
    --surface-1: #fcfcfb;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --grid: #e1e0d9;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --series-muted: #c3c2b7;
    --ord-1: #86b6ef;
    --ord-2: #3987e5;
    --ord-3: #1c5cab;
    --ord-4: #0d366b;
    --good: #006300;
    --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #0d0d0d;
      --surface-1: #1a1a19;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --grid: #2c2c2a;
      --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --series-muted: #52514e;
      --ord-1: #86b6ef;
      --ord-2: #3987e5;
      --ord-3: #256abf;
      --ord-4: #184f95;
      --good: #0ca30c;
      --critical: #e66767;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: var(--page); color: var(--text-primary);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 650; margin: 0; }
  .meta { color: var(--text-muted); font-size: 13px; margin: 4px 0 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile-label { font-size: 13px; color: var(--text-secondary); }
  .tile-value { font-size: 28px; font-weight: 600; margin-top: 2px; }
  .tile-value.tone-good { color: var(--good); }
  .tile-value.tone-critical { color: var(--critical); }
  .tile-detail { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .card h2 { font-size: 15px; font-weight: 600; margin: 0; }
  .subtitle { font-size: 12.5px; color: var(--text-muted); margin: 2px 0 0; }
  .card-actions { display: flex; align-items: center; gap: 14px; }
  .legend { display: flex; gap: 14px; font-size: 12.5px; color: var(--text-secondary); }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .toggle { font: inherit; font-size: 12.5px; color: var(--text-secondary); background: none; border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
  .toggle[aria-pressed="true"] { background: var(--grid); }
  .axis-label { fill: var(--text-secondary); font-size: 12.5px; }
  .value-label { fill: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .empty { color: var(--text-muted); font-size: 13.5px; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--text-muted); font-weight: 500; padding: 6px 10px; border-bottom: 1px solid var(--grid); }
  td { padding: 6px 10px; border-bottom: 1px solid var(--grid); }
  tr:last-child td { border-bottom: none; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.urgent { color: var(--critical); font-weight: 600; }
  #tooltip {
    position: fixed; pointer-events: none; display: none; z-index: 10;
    background: var(--text-primary); color: var(--page);
    font-size: 12.5px; padding: 6px 10px; border-radius: 6px; max-width: 320px;
  }
  @media print { .toggle { display: none; } body { padding: 0; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>Portfolio Dashboard${scopeLabel ? ` — ${esc(scopeLabel)}` : ""}</h1>
  <p class="meta">Generated ${generated.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })} · ${props.length} propert${props.length === 1 ? "y" : "ies"} · data from Rent Manager</p>

  <div class="tiles">
    ${statTile("Occupancy", `${occupancy.toFixed(1)}%`, `${occupiedUnits} of ${totalUnits} units`)}
    ${statTile("Scheduled monthly rent", moneyCompact(scheduledRent), "occupied units only")}
    ${statTile("Outstanding balances", moneyCompact(delinquentTotal), `${snapshot.delinquencies.length} delinquent tenant${snapshot.delinquencies.length === 1 ? "" : "s"}`, delinquentTotal > 0 ? "critical" : "good")}
    ${statTile("Vacant units", String(totalUnits - occupiedUnits), `${money(lostRent)}/mo market rent`)}
    ${statTile("Leases expiring ≤ 60 days", String(expiring60), `${snapshot.expiringLeases.length} within 90 days`)}
  </div>

  ${occCard}
  ${delByPropCard}
  ${agingCard}
  ${leaseCardHtml}
  ${vacantCardHtml}

  <p class="meta">Snapshot report — regenerate for current data. Built with rent-manager-mcp.</p>
</div>
<div id="tooltip" role="status"></div>
<script>
(function () {
  var tip = document.getElementById("tooltip");
  document.addEventListener("mousemove", function (e) {
    var t = e.target.closest ? e.target.closest(".hover-target") : null;
    if (t && t.dataset.tip) {
      tip.textContent = t.dataset.tip;
      tip.style.display = "block";
      var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      var y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    } else {
      tip.style.display = "none";
    }
  });
  document.querySelectorAll(".toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.dataset.card;
      var chart = document.getElementById(id + "-chart");
      var table = document.getElementById(id + "-table");
      var showTable = table.hidden;
      table.hidden = !showTable;
      chart.hidden = showTable;
      btn.setAttribute("aria-pressed", String(showTable));
      btn.textContent = showTable ? "Chart" : "Table";
    });
  });
})();
</script>
</body>
</html>`;
}
