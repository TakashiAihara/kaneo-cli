import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { slug } from "./record-golden";
import { SCENARIOS } from "../tests/parity/scenarios";
import type { ScenarioResult } from "../tests/parity/run";

// A readable view of a recorded golden: what each step ran, what it printed,
// and what it sent the fake that was not a plain read. The JSON the suite
// compares is exact and dense; this is for a person reviewing a change.
//
//   bun scripts/show-golden.ts <scenario name or golden file> [...more]
//
// A name is matched against the scenario names (slugged the way the golden
// file is named); anything else is taken as a path inside tests/parity/golden/.

const GOLDEN_DIR = new URL("../tests/parity/golden/", import.meta.url).pathname;

const fileFor = (arg: string): string => {
  if (arg.endsWith(".json") || arg.includes("/")) return arg;
  const named = SCENARIOS.filter((s) => s.name.toLowerCase().includes(arg.toLowerCase()));
  if (named.length === 1) return join(GOLDEN_DIR, `${slug(named[0]!.name)}.json`);
  const file = join(GOLDEN_DIR, `${slug(arg)}.json`);
  if (named.length === 0) return file;
  console.error(`"${arg}" names several scenarios: ${named.map((s) => s.name).join(", ")}`);
  process.exit(2);
};

const show = (file: string) => {
  const result = JSON.parse(readFileSync(file, "utf8")) as ScenarioResult;
  console.log(`## ${basename(file, ".json")}`);
  for (const step of result.steps) {
    console.log(`\n$ kaneo ${step.args.join(" ")}  ->  exit ${step.exit}`);
    const stdout =
      typeof step.stdout === "string"
        ? step.stdout
        : `<binary: ${Buffer.from(step.stdout.base64, "base64").length} bytes>`;
    if (stdout !== "") console.log(`stdout:\n${stdout}`);
    if (step.stderr !== "") console.log(`stderr:\n${step.stderr}`);
  }
  const writes = result.requests.filter((r) => r.method !== "GET");
  if (writes.length > 0) {
    console.log("\nrequests that were not GET:");
    for (const r of writes) {
      // query is the request's raw search string, leading ? included.
      const query = r.query === "" ? "" : r.query;
      const body = r.body === undefined ? "" : `\n  body: ${JSON.stringify(r.body)}`;
      console.log(`  ${r.method} ${r.path}${query}${body}`);
    }
  }
  const files = Object.keys(result.files);
  if (files.length > 0) {
    console.log("\nfiles left under the config dir and cwd:");
    for (const f of files) console.log(`  ${f}`);
  }
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("usage: bun scripts/show-golden.ts <scenario name or golden file> [...more]");
  console.log("\ngolden files:");
  for (const name of readdirSync(GOLDEN_DIR).sort()) console.log(`  ${name}`);
  process.exit(2);
}
for (const arg of args) show(fileFor(arg));
