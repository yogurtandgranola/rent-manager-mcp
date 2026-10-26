const currencyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function money(amount: number | null | undefined): string {
  return currencyFormat.format(amount ?? 0);
}

export function pct(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

/** Rent Manager dates come back as "2024-03-01T00:00:00". Show the date part only. */
export function day(value: string | null | undefined): string {
  if (!value) return "-";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : value;
}

function cell(value: unknown): string {
  const text = value === null || value === undefined || value === "" ? "-" : String(value);
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

export function table(headers: string[], rows: unknown[][]): string {
  const lines = [
    `| ${headers.map(cell).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  return lines.join("\n") + "\n";
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
