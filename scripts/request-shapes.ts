import { readFileSync, writeFileSync } from "node:fs";
import { SPEC_PATH } from "../openapi/spec";
import { OPERATIONS } from "../src/api/registry";
import { requestShapes } from "../src/api/shape";

// Writes the request side of every registry operation, as the pinned document
// has it, to src/api/gen/requests.json, which api-check compares a server's
// document against. Generated rather than read from the pinned document at run
// time: the built binary does not carry that file. `bun run generate` runs it
// after Orval, whose clean step empties src/api/gen first.
const shapes = requestShapes(JSON.parse(readFileSync(SPEC_PATH, "utf8")), OPERATIONS.map((op) => op.id));
const sorted = Object.fromEntries(
  Object.keys(shapes)
    .sort()
    .map((id) => [id, Object.fromEntries(Object.entries(shapes[id]!).sort(([a], [b]) => (a < b ? -1 : 1)))]),
);
writeFileSync(new URL("../src/api/gen/requests.json", import.meta.url).pathname, JSON.stringify(sorted, null, 2) + "\n");
