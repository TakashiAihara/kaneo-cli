import { describe, expect, test } from "bun:test";
import { printTable } from "../src/output";

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe("printTable", () => {
  test("wide-character header wider than its cells still aligns the next column", () => {
    // バグが出るのはヘッダが列の最長要素のとき: header.length (2) で幅を測ると
    // 表示幅 4 の「名前」がはみ出し、次列の開始位置がヘッダ行とデータ行でずれる
    const rows = [{ name: "x", id: "1" }];
    const lines = capture(() =>
      printTable(rows, [
        { header: "名前", value: (r) => r.name },
        { header: "ID", value: (r) => r.id },
      ]),
    );
    const headerIdCol = lines[0]!.indexOf("ID");
    const dataIdCol = lines[1]!.indexOf("1");
    expect(visible(lines[0]!.slice(0, headerIdCol))).toBe(visible(lines[1]!.slice(0, dataIdCol)));
  });

  test("ascii columns align by character count", () => {
    const lines = capture(() =>
      printTable(
        [
          { a: "x", b: "yy" },
          { a: "long-value", b: "z" },
        ],
        [
          { header: "A", value: (r) => r.a },
          { header: "B", value: (r) => r.b },
        ],
      ),
    );
    const col = lines[0]!.indexOf("B");
    expect(lines[1]!.indexOf("yy")).toBe(col);
    expect(lines[2]!.indexOf("z")).toBe(col);
  });
});

// テスト内でも実装と独立に表示幅を数える (CJK=2)
function visible(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code >= 0x1100 ? 2 : 1;
  }
  return w;
}
