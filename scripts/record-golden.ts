import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { runScenario, THIS_BUILD } from "../tests/parity/run";
import { SCENARIOS } from "../tests/parity/scenarios";

// Records what a build does for every parity scenario into tests/parity/golden/.
//
//   bun scripts/record-golden.ts               only the goldens this source tree
//                                              no longer matches, and new ones
//   bun scripts/record-golden.ts -t <regex>    only the scenarios the regex
//                                              names, for a targeted re-record
//   bun scripts/record-golden.ts --bin <kaneo> every golden, from that binary
//
// The goldens were first recorded from the last Go build; that is the contract
// the TS build was held to. A change that means to alter output records the
// affected goldens again from this tree. Recording from source rather than
// through a wrapper script matters: the scenarios that set PATH to a directory
// that does not exist would not find `bun` from a wrapper, and their goldens
// would record that failure instead.
// A golden is rewritten when its text differs, key order included. The suite
// compares request bodies as values, so an order-only change would otherwise
// sit unwritten until an unrelated change rewrote the file and showed it there.

export function slug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const USAGE = "usage: bun scripts/record-golden.ts [-t <scenario name regex>] [--bin <kaneo binary>]";

// The binary to record from and the scenarios to record, or exits. Anything
// but the known forms is refused, so a typo or --help says what the script
// takes rather than failing to start a binary by that name on the first
// scenario. -t keeps the runs a change actually touches from paying for the
// whole suite.
const optionsFrom = (args: string[]): { bin: string | undefined; only: RegExp | undefined } => {
  let bin: string | undefined;
  let only: RegExp | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--bin" && i + 1 < args.length && args[i + 1] !== "") {
      bin = args[++i];
    } else if (arg === "-t" && i + 1 < args.length && args[i + 1] !== "") {
      try {
        only = new RegExp(args[++i]!);
      } catch (e) {
        console.error(`-t: ${(e as Error).message}`);
        process.exit(2);
      }
    } else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  return { bin, only };
};

async function record(bin: string | undefined, only: RegExp | undefined) {
  // Two names that slug alike would share one golden, the later overwriting
  // the earlier without a word.
  const slugs = SCENARIOS.map((s) => slug(s.name));
  const clash = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (clash.length > 0) {
    console.error(`scenario names collide as golden files: ${[...new Set(clash)].join(", ")}`);
    process.exit(2);
  }
  const scenarios = only === undefined ? SCENARIOS : SCENARIOS.filter((s) => only.test(s.name));
  if (scenarios.length === 0) {
    console.error(`-t ${only} matched no scenario`);
    process.exit(2);
  }
  const dir = new URL("../tests/parity/golden/", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const host = hostname();
  let written = 0;
  for (const s of scenarios) {
    const file = `${dir}${slug(s.name)}.json`;
    const result = await runScenario(bin === undefined ? THIS_BUILD : [bin], s);
    const text = JSON.stringify(result, null, 2) + "\n";
    if (bin === undefined && existsSync(file) && readFileSync(file, "utf8") === text) continue;
    // The goldens are published with the repository. The recording machine's
    // name surviving normalisation means a new place prints it; stop rather
    // than publish it, and extend the normalisation in tests/parity/run.ts.
    if (new RegExp(`(^|[^A-Za-z0-9-])${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9-]|$)`).test(text)) {
      console.error(`${s.name}: the output still holds this machine's name (${host}); not written`);
      process.exit(2);
    }
    writeFileSync(file, text);
    written++;
    console.log(
      `${result.steps
        .map((x) => x.exit)
        .join(",")
        .padEnd(12)} ${s.name}`,
    );
  }
  // A golden whose scenario was renamed or removed is never compared again, so
  // it would sit there looking like coverage.
  const known = new Set(slugs.map((s) => `${s}.json`));
  for (const name of readdirSync(dir).sort()) {
    if (!known.has(name)) console.error(`no scenario records ${name}; delete it if the scenario is gone`);
  }
  console.log(`${written} written`);
}

if (import.meta.main) {
  const { bin, only } = optionsFrom(process.argv.slice(2));
  await record(bin, only);
}
