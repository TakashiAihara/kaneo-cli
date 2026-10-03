import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { runScenario } from "../tests/parity/run";
import { SCENARIOS } from "../tests/parity/scenarios";

// Records what the Go reference build does for every parity scenario. Run once
// against the last Go release; the output is the contract the TS build is held
// to. Usage: bun scripts/record-golden.ts <path to the Go kaneo binary>

export function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function record(bin: string | undefined) {
  if (!bin) {
    console.error("usage: bun scripts/record-golden.ts <go-kaneo-binary>");
    process.exit(2);
  }
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
  for (const s of SCENARIOS) {
    const result = await runScenario([bin], s);
    const text = JSON.stringify(result, null, 2) + "\n";
    // The goldens are published with the repository. The recording machine's
    // name surviving normalisation means a new place prints it; stop rather
    // than publish it, and extend the normalisation in tests/parity/run.ts.
    const host = hostname();
    if (new RegExp(`(^|[^A-Za-z0-9-])${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9-]|$)`).test(text)) {
      console.error(`${s.name}: the output still holds this machine's name (${host}); not written`);
      process.exit(2);
    }
    writeFileSync(`${dir}${slug(s.name)}.json`, text);
    console.log(`${result.steps.map((x) => x.exit).join(",").padEnd(12)} ${s.name}`);
  }
}

if (import.meta.main) await record(process.argv[2]);
