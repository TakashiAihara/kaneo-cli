import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SPEC_PATH } from "../../openapi/spec";
import { OPERATIONS } from "../../src/api/registry";
import { requestDrift, requestShapes } from "../../src/api/shape";
import pinned from "../../src/api/gen/requests.json";

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
    expect(requestShapes(doc, OPERATIONS.map((o) => o.id))).toEqual(pinned);
  });
});

describe("requestDrift", () => {
  test("a field the server no longer takes", () => {
    expect(requestDrift({ a: { "body.old": false } }, { a: {} })).toEqual([{ id: "a", field: "body.old", problem: "gone" }]);
  });

  test("a field the server requires that the client does not know", () => {
    expect(requestDrift({ a: {} }, { a: { "body.new": true } })).toEqual([{ id: "a", field: "body.new", problem: "required" }]);
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
    expect(got.map((d) => `${d.id} ${d.field}`)).toEqual(["createTask body.b", "createTask body.z", "createTaskComment body.a"]);
  });

  test("the same document has no drift", () => {
    expect(requestDrift(pinned, pinned)).toEqual([]);
  });
});
