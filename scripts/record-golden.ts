import { mkdirSync, writeFileSync } from "node:fs";
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
  const dir = new URL("../tests/parity/golden/", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  for (const s of SCENARIOS) {
    const result = await runScenario([bin], s);
    writeFileSync(`${dir}${slug(s.name)}.json`, JSON.stringify(result, null, 2) + "\n");
    console.log(`${result.steps.map((x) => x.exit).join(",").padEnd(12)} ${s.name}`);
  }
}

if (import.meta.main) await record(process.argv[2]);
