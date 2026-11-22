import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Mutation testing for the files a change touched, before adversarial
// review: StrykerJS rewrites each changed file one expression at a time and
// the parity/unit suites say which rewrites nothing catches.
//
//   bun scripts/mutate.ts                 changed files vs origin/main
//   bun scripts/mutate.ts --files a.ts,b  an explicit list instead
//
// Stryker's command runner has no coverage analysis, so every mutant pays for
// the whole chosen suite; the suite is picked from what changed:
// tests/parity/** runs the golden suite, src/** and tests/unit/** the unit
// tests, and both when a change can move either. scripts/** has no suite that
// imports it and is reported rather than mutated — every mutant there would
// survive by construction. Measure a real run before making this a gate:
// the parity suite is the expensive one (~4 min per mutant here, which is
// why stryker.conf.json's timeoutMS is 10 minutes).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const changedFiles = (): string[] => {
  const listed = Bun.spawnSync(["git", "diff", "--name-only", "origin/main"], { cwd: ROOT })
    .stdout.toString()
    .trim()
    .split("\n")
    .filter((f) => f !== "");
  const untracked = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard"], { cwd: ROOT })
    .stdout.toString()
    .trim()
    .split("\n")
    .filter((f) => f !== "");
  return [...new Set([...listed, ...untracked])];
};

// The suite a changed file is answerable to, or undefined when nothing runs
// it. src/** moves both suites' answers, so it asks for both.
const suiteFor = (file: string): string[] => {
  if (file.startsWith("tests/parity/")) return ["tests/parity"];
  if (file.startsWith("tests/unit/")) return ["tests/unit"];
  if (file.startsWith("src/")) return ["tests/unit", "tests/parity"];
  return [];
};

const args = process.argv.slice(2);
let files: string[];
if (args[0] === "--files" && args[1] !== undefined) {
  files = args[1]!.split(",").filter((f) => f !== "");
} else if (args.length === 0) {
  files = changedFiles();
} else {
  console.error("usage: bun scripts/mutate.ts [--files <comma-separated paths>]");
  process.exit(2);
}

const mutable = files.filter((f) => f.endsWith(".ts") && existsSync(join(ROOT, f)) && !f.endsWith(".test.ts"));
const skipped = files.filter((f) => !mutable.includes(f));
for (const f of skipped) console.log(`skipped ${f}: not a mutable .ts file`);

const suites = [...new Set(mutable.flatMap(suiteFor))];
const uncovered = mutable.filter((f) => suiteFor(f).length === 0);
for (const f of uncovered) console.log(`note: no suite covers ${f}; its mutants would all survive`);

if (mutable.length === 0 || suites.length === 0) {
  console.log("nothing to mutate that a suite answers for");
  process.exit(0);
}

const run = Bun.spawnSync(
  [
    join(ROOT, "node_modules/.bin/stryker"),
    "run",
    ...mutable.flatMap((f) => ["--mutate", f]),
    "--commandRunner.command",
    `bun test ${suites.join(" ")}`,
  ],
  { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] },
);
process.exit(run.exitCode ?? 1);
