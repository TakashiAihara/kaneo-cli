import { readFileSync, writeFileSync } from "node:fs";
import { SPEC_PATH } from "../openapi/spec";
import { OPERATIONS } from "../src/api/registry";
import { requestShapes, serverOperations } from "../src/api/shape";

// Writes what the pinned document says about this client's operations to
// src/api/gen/: requests.json, the request side api-check compares a server's
// document against, and spec-operations.json, every operation the document
// serves, which api-check diffs against the server's the other way. Generated
// rather than read from the pinned document at run time: the built binary does
// not carry that file. `bun run generate` runs it after Orval, whose clean
// step empties src/api/gen first.
const document = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const shapes = requestShapes(
  document,
  OPERATIONS.map((op) => op.id),
);
const sorted = Object.fromEntries(
  Object.keys(shapes)
    .sort()
    .map((id) => [id, Object.fromEntries(Object.entries(shapes[id]!).sort(([a], [b]) => (a < b ? -1 : 1)))]),
);
writeFileSync(
  new URL("../src/api/gen/requests.json", import.meta.url).pathname,
  JSON.stringify(sorted, null, 2) + "\n",
);
writeFileSync(
  new URL("../src/api/gen/spec-operations.json", import.meta.url).pathname,
  JSON.stringify(serverOperations(document), null, 2) + "\n",
);
