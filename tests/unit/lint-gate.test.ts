import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../../package.json";

// The gate is configuration, and configuration that stops being read fails
// nothing: without --type-aware, or without the rule, lint passes over a
// switch that forgot a member. So the script package.json really runs is run
// here, over a switch that must be refused and one that must not be.

const ROOT = join(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "kaneo-lint-gate-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SHAPE = 'type Shape = { at: "circle" } | { at: "square" } | { at: "line" };';

const lint = (name: string, cases: string): { exitCode: number; output: string } => {
  const dir = join(scratch, name);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "shape.ts"),
    `${SHAPE}\nexport const name = (shape: Shape): string => {\n  switch (shape.at) {\n${cases}\n  }\n};\n`,
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "bundler", noEmit: true } }),
  );
  const [tool, ...flags] = manifest.scripts.lint.split(" ");
  const run = Bun.spawnSync(
    [join(ROOT, "node_modules/.bin", tool!), ...flags, "-c", join(ROOT, ".oxlintrc.json"), dir],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return { exitCode: run.exitCode, output: run.stdout.toString() + run.stderr.toString() };
};

test("lint refuses a switch that leaves union members to default", () => {
  const { exitCode, output } = lint(
    "default",
    '    case "circle":\n      return "c";\n    default:\n      return "other";',
  );

  expect(output).toContain("switch-exhaustiveness-check");
  expect(output).toContain('"line" | "square"');
  expect(exitCode).toBe(1);
});

test("lint passes a switch that names every union member", () => {
  const { exitCode, output } = lint(
    "named",
    '    case "circle":\n      return "c";\n    case "square":\n    case "line":\n      return "other";',
  );

  expect(output).not.toContain("switch-exhaustiveness-check");
  expect(exitCode).toBe(0);
});
