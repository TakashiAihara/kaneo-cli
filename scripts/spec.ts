import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { SPEC_VERSION, SPEC_PATH } from "../openapi/spec";

// Re-pins the OpenAPI document to another Kaneo release: downloads the
// document shipped at that tag, unchanged, replaces the pinned file and the
// version in openapi/spec.ts. Run `bun run generate` afterwards and review the
// diff of src/api/gen.
const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error("usage: bun run spec <version>   (for example 2.30.0)");
  process.exit(2);
}
const url = `https://raw.githubusercontent.com/usekaneo/kaneo/v${next}/apps/docs/openapi.json`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`${url}: ${res.status}`);
  process.exit(1);
}
const body = await res.text();
JSON.parse(body);

const specTs = new URL("../openapi/spec.ts", import.meta.url).pathname;
writeFileSync(SPEC_PATH.replace(SPEC_VERSION, next), body);
writeFileSync(specTs, readFileSync(specTs, "utf8").replace(`"${SPEC_VERSION}"`, `"${next}"`));
if (next !== SPEC_VERSION) rmSync(SPEC_PATH);
console.log(`pinned ${next}; now run: bun run generate`);
