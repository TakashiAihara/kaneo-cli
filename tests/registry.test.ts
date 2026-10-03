import { expect, test } from "bun:test";
import * as client from "../src/api/gen/kaneo";
import { OPERATIONS } from "../src/api/registry";
import { readFileSync } from "node:fs";
import { SPEC_PATH } from "../openapi/spec";

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));

// The registry is the list the client is generated for and the list api-check
// compares against a server. An id that the pinned document lacks, or whose
// method or path differs from it, would be dropped from generation without a
// word and checked against the wrong route, so each is held to the document.
const documented = new Map<string, { method: string; path: string }>();
for (const [path, item] of Object.entries((spec as any).paths)) {
  for (const [method, op] of Object.entries(item as Record<string, any>)) {
    if (op?.operationId) documented.set(op.operationId, { method: method.toUpperCase(), path });
  }
}

test.each(OPERATIONS.map((op) => [op.id, op] as const))("%s matches the pinned document", (_id, op) => {
  expect(documented.get(op.id)).toEqual({ method: op.method, path: op.path });
});

test.each(OPERATIONS.map((op) => [op.id] as const))("%s has a generated client function", (id) => {
  expect(typeof (client as Record<string, unknown>)[id]).toBe("function");
});

// A registry entry removed without regenerating would leave a client for an
// operation nothing declares any more.
test("the generated client has exactly the registry's operations", () => {
  const generated = Object.keys(client).filter((name) => documented.has(name));
  expect(generated.sort()).toEqual(OPERATIONS.map((op) => op.id).sort());
});
