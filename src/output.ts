// stdout = データ / stderr = ログ。--json のときは stdout に JSON 以外を出さない

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function log(message: string): void {
  console.error(message);
}

export type Column<T> = {
  header: string;
  value: (row: T) => string;
};

export function printTable<T>(rows: T[], columns: Column<T>[]): void {
  const cells = rows.map((r) => columns.map((c) => c.value(r)));
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((row) => visibleWidth(row[i] ?? ""))),
  );
  const line = (parts: string[]) =>
    parts.map((p, i) => pad(p, widths[i] ?? 0)).join("  ").trimEnd();
  console.log(line(columns.map((c) => c.header)));
  for (const row of cells) console.log(line(row));
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

// East Asian Wide をざっくり 2 桁として数える。表崩れを完全には防げないが、
// タイトルが日本語のタスクで毎回崩れるよりよい
function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code >= 0x1100 && isWide(code) ? 2 : 1;
  }
  return w;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}
