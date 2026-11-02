import { expect, test } from "bun:test";
import * as client from "../src/api/gen/kaneo";
import { OPERATIONS } from "../src/api/registry";
import { rootCommand } from "../src/cli/root";
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

// `command` is what api-check tells a person will break, so a command that does
// not exist sends them looking for something they cannot find.
type Node = { name: string; aliases?: string[]; children?: Node[] };

const root = rootCommand().root as Node;

const walk = (from: Node, words: string[]): Node[] | undefined => {
  const path: Node[] = [];
  let at = from;
  for (const word of words) {
    const next = at.children?.find((c) => c.name === word || c.aliases?.includes(word));
    if (next === undefined) return undefined;
    path.push(next);
    at = next;
  }
  return path;
};

const wordsOf = (alternative: string): string[] =>
  alternative
    .replace(/<[^>]*>/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "" && !w.startsWith("-"));

// Returns the alternatives that lead nowhere.
const unresolved = (command: string): string[] => {
  const [head, ...later] = command.split(" / ");
  const first = wordsOf(head!);
  if (first[0] !== "kaneo") return [command];
  const firstPath = walk(root, first.slice(1));
  if (firstPath === undefined) return [head!];
  // A later alternative is a sibling of the first ("task ls / board") or a path
  // from the root ("whoami / workspace ls").
  const parents = firstPath.slice(0, -1);
  const parent = parents.length === 0 ? root : parents[parents.length - 1]!;
  return later.filter((alt) => {
    const words = wordsOf(alt);
    return walk(parent, words) === undefined && walk(root, words) === undefined;
  });
};

test.each(OPERATIONS.map((op) => [op.id, op.command] as const))("%s names a command that exists", (_id, command) => {
  expect(unresolved(command)).toEqual([]);
});

test("the command check tells a missing command from a present one", () => {
  expect(unresolved("kaneo task unlinkk")).toEqual(["kaneo task unlinkk"]);
  expect(unresolved("task get")).toEqual(["task get"]);
  expect(unresolved("whoami")).toEqual(["whoami"]);
  expect(unresolved("kaneo task ls / nosuch")).toEqual(["nosuch"]);
  expect(unresolved("kaneo task ls --mine / board <x>")).toEqual([]);
  expect(unresolved("kaneo whoami / workspace ls")).toEqual([]);
});
