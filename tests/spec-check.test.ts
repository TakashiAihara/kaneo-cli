import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPEC_PATH, SPEC_VERSION } from "../openapi/spec";

// `bun run spec --check`, with fetch replaced by a preload that answers with a
// local file, so the comparison CI relies on is pinned without the network.
const dir = mkdtempSync(join(tmpdir(), "kaneo-spec-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stub = join(dir, "stub.ts");
writeFileSync(
  stub,
  `globalThis.fetch = async (url) => {
    await Bun.write(process.env.STUB_SEEN, String(url));
    return new Response(Bun.file(process.env.STUB_BODY));
  };`,
);

const run = (body: string, ...args: string[]) => {
  const seen = join(dir, "seen");
  const p = Bun.spawnSync(["bun", "--preload", stub, "scripts/spec.ts", ...args], {
    env: { ...process.env, STUB_BODY: body, STUB_SEEN: seen },
  });
  return { exit: p.exitCode, stderr: p.stderr.toString(), seen: () => readFileSync(seen, "utf8") };
};

test("passes when the release's document is the pinned file", () => {
  const r = run(SPEC_PATH, "--check");
  expect(r.exit).toBe(0);
  expect(r.seen()).toBe(`https://raw.githubusercontent.com/usekaneo/kaneo/v${SPEC_VERSION}/apps/docs/openapi.json`);
});

test("fails when one byte differs", () => {
  const changed = join(dir, "changed.json");
  writeFileSync(changed, Buffer.concat([readFileSync(SPEC_PATH), Buffer.from(" ")]));
  const r = run(changed, "--check");
  expect(r.exit).toBe(1);
  expect(r.stderr).toContain("corrections go in openapi/transformer.ts");
});

test("refuses anything after --check rather than ignoring it", () => {
  expect(run(SPEC_PATH, "--check", "extra").exit).toBe(2);
});
