import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SPEC_VERSION, SPEC_PATH } from "../openapi/spec";

// Re-pins the OpenAPI document to another Kaneo release: downloads the
// document shipped at that tag, unchanged, replaces the pinned file and the
// version in openapi/spec.ts. Run `bun run generate` afterwards and review the
// diff of src/api/gen.
//
// `--check` downloads the pinned version's document and fails unless the
// pinned file is byte for byte the same. CI runs it: regenerating only proves
// the client matches the pinned file, not that the file is the release's.
const arg = process.argv[2];
const check = arg === "--check";
const next = check ? SPEC_VERSION : arg;
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error("usage: bun run spec <version>   (for example 2.30.0)\n       bun run spec --check");
  process.exit(2);
}
const url = `https://raw.githubusercontent.com/usekaneo/kaneo/v${next}/apps/docs/openapi.json`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`${url}: ${res.status}`);
  process.exit(1);
}
const body = await res.text();

if (check) {
  if (readFileSync(SPEC_PATH, "utf8") !== body) {
    console.error(`${SPEC_PATH} differs from ${url}; re-pin with: bun run spec ${next}`);
    process.exit(1);
  }
  console.log(`pinned spec matches v${next}`);
  process.exit(0);
}

JSON.parse(body);

const specTs = new URL("../openapi/spec.ts", import.meta.url).pathname;
// Only the file name carries the version; the directories above it may hold
// the same digits.
writeFileSync(join(dirname(SPEC_PATH), basename(SPEC_PATH).replace(SPEC_VERSION, next)), body);
writeFileSync(specTs, readFileSync(specTs, "utf8").replace(`"${SPEC_VERSION}"`, `"${next}"`));
if (next !== SPEC_VERSION) rmSync(SPEC_PATH);
console.log(`pinned ${next}; now run: bun run generate`);
