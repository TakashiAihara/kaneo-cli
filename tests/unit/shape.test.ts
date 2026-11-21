import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SPEC_PATH } from "../../openapi/spec";
import { OPERATIONS, type Operation } from "../../src/api/registry";
import { clientShapes, requestDrift, requestShapes, serverOperations } from "../../src/api/shape";
import pinned from "../../src/api/gen/requests.json";
import specOperations from "../../src/api/gen/spec-operations.json";

const op = (operationId: string, rest: object = {}) => ({ paths: { "/x": { put: { operationId, ...rest } } } });

describe("requestShapes", () => {
  // A path parameter is filled by position, so its name is not compared.
  test("keys query parameters and body fields by name, with required, and skips path ones", () => {
    const doc = op("a", {
      parameters: [
        { name: "id", in: "path", required: true },
        { name: "limit", in: "query" },
      ],
      requestBody: {
        content: { "application/json": { schema: { properties: { title: {}, note: {} }, required: ["title"] } } },
      },
    });
    expect(requestShapes(doc, ["a"])).toEqual({
      a: { "query.limit": false, "body.title": true, "body.note": false },
    });
  });

  test("follows references, chained and with escaped keys", () => {
    const doc = {
      ...op("a", {
        parameters: [{ $ref: "#/components/parameters/Q" }],
        requestBody: { $ref: "#/components/requestBodies/B" },
      }),
      components: {
        parameters: { Q: { name: "q", in: "query", required: true } },
        requestBodies: { B: { content: { "application/json": { schema: { $ref: "#/components/schemas/a~1b" } } } } },
        schemas: { "a/b": { $ref: "#/components/schemas/S" }, S: { properties: { title: {} }, required: ["title"] } },
      },
    };
    expect(requestShapes(doc, ["a"])).toEqual({ a: { "query.q": true, "body.title": true } });
  });

  test("takes path-level parameters, with the operation's own replacing one of the same name", () => {
    const doc = {
      paths: {
        "/x/{id}": {
          parameters: [
            { name: "p", in: "query", required: true },
            { name: "q", in: "query", required: true },
          ],
          put: { operationId: "a", parameters: [{ name: "q", in: "query", required: false }] },
        },
      },
    };
    expect(requestShapes(doc, ["a"])).toEqual({ a: { "query.p": true, "query.q": false } });
  });

  test("takes a required body field that properties does not list", () => {
    const doc = op("a", { requestBody: { content: { "application/json": { schema: { required: ["x"] } } } } });
    expect(requestShapes(doc, ["a"])).toEqual({ a: { "body.x": true } });
  });

  test("compares header names case-insensitively", () => {
    const doc = op("a", { parameters: [{ name: "X-Trace", in: "header", required: true }] });
    expect(requestShapes(doc, ["a"])).toEqual({ a: { "header.x-trace": true } });
  });

  test("leaves out operations it was not asked for", () => {
    expect(requestShapes(op("other"), ["a"])).toEqual({});
  });

  // A stale requests.json (a registry or extractor change committed without
  // regenerating) fails here as well as in CI's diff, which only runs there.
  test("requests.json is what the pinned document gives", () => {
    const doc = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
    expect(
      requestShapes(
        doc,
        OPERATIONS.map((o) => o.id),
      ),
    ).toEqual(pinned);
  });

  test("spec-operations.json is what the pinned document serves", () => {
    const doc = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
    expect(serverOperations(doc)).toEqual(specOperations);
  });
});

describe("clientShapes", () => {
  const registryOp = (id: string, fields: Partial<Operation>): Operation => ({
    id,
    method: "GET",
    path: "/x",
    command: "kaneo x",
    ...fields,
  });

  test("drops neverSent fields and promotes alwaysSent ones to required", () => {
    const ops = [registryOp("a", { neverSent: ["body.gone", "query.gone"], alwaysSent: ["body.opt"] })];
    expect(
      clientShapes({ a: { "body.gone": false, "body.opt": false, "body.req": true, "query.gone": false } }, ops),
    ).toEqual({ a: { "body.opt": true, "body.req": true } });
  });

  test("an operation the pinned shape lacks keeps an empty shape", () => {
    expect(clientShapes({}, [registryOp("a", { neverSent: ["body.x"] })])).toEqual({ a: {} });
  });

  // A declaration naming a field the document does not mark optional is a lie
  // the drift check cannot see: neverSent on a required field would hide that
  // calls must send it, alwaysSent on one the calls may omit would hide that
  // they sometimes do not. Holding every declaration to the pinned optional
  // set is what keeps the narrowed shape honest.
  test.each(
    OPERATIONS.flatMap((o) =>
      [...(o.neverSent ?? []), ...(o.alwaysSent ?? [])].map((field) => [`${o.id} ${field}`, o.id, field] as const),
    ),
  )("declared %s is optional in the pinned shape", (_name, id, field) => {
    const shape = (pinned as Record<string, Record<string, boolean>>)[id] ?? {};
    expect(shape[field]).toBe(false);
  });
});

describe("requestDrift", () => {
  test("a field the server no longer takes", () => {
    expect(requestDrift({ a: { "body.old": false } }, { a: {} })).toEqual([
      { id: "a", field: "body.old", problem: "gone" },
    ]);
  });

  test("a field the server requires that the client does not know", () => {
    expect(requestDrift({ a: {} }, { a: { "body.new": true } })).toEqual([
      { id: "a", field: "body.new", problem: "required" },
    ]);
  });

  test("a field the server requires that the client may leave out", () => {
    expect(requestDrift({ a: { "body.x": false } }, { a: { "body.x": true } })).toEqual([
      { id: "a", field: "body.x", problem: "required" },
    ]);
  });

  test("an optional field the server added, or one it relaxed, breaks nothing", () => {
    expect(requestDrift({ a: { "body.x": true } }, { a: { "body.x": false, "body.new": false } })).toEqual([]);
  });

  test("an operation the server lacks is left to the missing list", () => {
    expect(requestDrift({ a: { "body.x": true } }, {})).toEqual([]);
  });

  test("sorts by operation, then field", () => {
    const got = requestDrift(
      { createTaskComment: { "body.a": false }, createTask: { "body.z": false, "body.b": false } },
      { createTaskComment: {}, createTask: {} },
    );
    expect(got.map((d) => `${d.id} ${d.field}`)).toEqual([
      "createTask body.b",
      "createTask body.z",
      "createTaskComment body.a",
    ]);
  });

  test("the same document has no drift", () => {
    expect(requestDrift(pinned, pinned)).toEqual([]);
  });
});

describe("serverOperations", () => {
  test("lists each operation with its method, path and first tag, by id", () => {
    const doc = {
      paths: {
        "/b": {
          parameters: [{ name: "x", in: "query" }],
          summary: "not an operation",
          "x-internal": { operationId: "extension" },
          get: { operationId: "listB", tags: ["Bee", "Second"] },
        },
        "/a/{id}": {
          delete: { operationId: "removeA" },
          put: { operationId: "putA", tags: "not a list" },
          post: { operationId: "listB", tags: ["Again"] },
          patch: { operationId: "" },
        },
      },
    };
    expect(serverOperations(doc)).toEqual([
      { id: "listB", method: "GET", path: "/b", tag: "Bee" },
      { id: "putA", method: "PUT", path: "/a/{id}", tag: "" },
      { id: "removeA", method: "DELETE", path: "/a/{id}", tag: "" },
    ]);
  });

  test("a document with no paths offers nothing", () => {
    expect(serverOperations({})).toEqual([]);
  });
});
