import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { runScenario, sameResult, THIS_BUILD, type ScenarioResult } from "../tests/parity/run";
import { SCENARIOS } from "../tests/parity/scenarios";

// Records what a build does for every parity scenario into tests/parity/golden/.
//
//   bun scripts/record-golden.ts               only the goldens this source tree
//                                              no longer matches, and new ones
//   bun scripts/record-golden.ts --bin <kaneo> every golden, from that binary
//
// The goldens were first recorded from the last Go build; that is the contract
// the TS build was held to. A change that means to alter output records the
// affected goldens again from this tree. Recording from source rather than
// through a wrapper script matters: the scenarios that set PATH to a directory
// that does not exist would not find `bun` from a wrapper, and their goldens
// would record that failure instead.
// Only differing goldens are rewritten, because a golden that already matches
// under the suite's own comparison (request bodies compared as values, so key
// order is free) would otherwise churn for nothing.

export function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const USAGE = "usage: bun scripts/record-golden.ts [--bin <kaneo binary>]";

// The binary to record from, or undefined for this source tree. Anything but
// the two forms is refused: a typo read as a binary would rewrite every golden
// from a program that does not exist.
const binaryFrom = (args: string[]): string | undefined => {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--bin" && args[1] !== "") return args[1];
  console.error(USAGE);
  process.exit(2);
};

async function record(bin: string | undefined) {
  // Two names that slug alike would share one golden, the later overwriting
  // the earlier without a word.
  const slugs = SCENARIOS.map((s) => slug(s.name));
  const clash = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (clash.length > 0) {
    console.error(`scenario names collide as golden files: ${[...new Set(clash)].join(", ")}`);
    process.exit(2);
  }
  const dir = new URL("../tests/parity/golden/", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const host = hostname();
  let written = 0;
  for (const s of SCENARIOS) {
    const file = `${dir}${slug(s.name)}.json`;
    const result = await runScenario(bin === undefined ? THIS_BUILD : [bin], s);
    if (bin === undefined && existsSync(file)) {
      const want: ScenarioResult = JSON.parse(readFileSync(file, "utf8"));
      if (sameResult(want, result)) continue;
    }
    const text = JSON.stringify(result, null, 2) + "\n";
    // The goldens are published with the repository. The recording machine's
    // name surviving normalisation means a new place prints it; stop rather
    // than publish it, and extend the normalisation in tests/parity/run.ts.
    if (new RegExp(`(^|[^A-Za-z0-9-])${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9-]|$)`).test(text)) {
      console.error(`${s.name}: the output still holds this machine's name (${host}); not written`);
      process.exit(2);
    }
    writeFileSync(file, text);
    written++;
    console.log(`${result.steps.map((x) => x.exit).join(",").padEnd(12)} ${s.name}`);
  }
  // A golden whose scenario was renamed or removed is never compared again, so
  // it would sit there looking like coverage.
  const known = new Set(slugs.map((s) => `${s}.json`));
  for (const name of readdirSync(dir).sort()) {
    if (!known.has(name)) console.error(`no scenario records ${name}; delete it if the scenario is gone`);
  }
  console.log(`${written} written`);
}

if (import.meta.main) await record(binaryFrom(process.argv.slice(2)));
