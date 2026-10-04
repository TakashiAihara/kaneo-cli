import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SPEC_PATH } from "../../openapi/spec";
import { OPERATIONS } from "../../src/api/registry";
import { requestDrift, requestShapes } from "../../src/api/shape";
import pinned from "../../src/api/gen/requests.json";

const op = (operationId: string, rest: object = {}) => ({ paths: { "/x": { put: { operationId, ...rest } } } });

describe("requestShapes", () => {
  test("keys parameters by where they go and body fields by name, with required", () => {
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
      a: { "path.id": true, "query.limit": false, "body.title": true, "body.note": false },
    });
  });

  test("follows references to parameters, bodies and schemas", () => {
    const doc = {
      ...op("a", {
        parameters: [{ $ref: "#/components/parameters/Id" }],
        requestBody: { $ref: "#/components/requestBodies/B" },
      }),
      components: {
        parameters: { Id: { name: "id", in: "path", required: true } },
        requestBodies: { B: { content: { "application/json": { schema: { $ref: "#/components/schemas/S" } } } } },
        schemas: { S: { properties: { title: {} }, required: ["title"] } },
      },
    };
    expect(requestShapes(doc, ["a"])).toEqual({ a: { "path.id": true, "body.title": true } });
  });

  test("leaves out operations it was not asked for", () => {
    expect(requestShapes(op("other"), ["a"])).toEqual({});
  });

  // CI regenerates requests.json and fails on a diff, but that does not catch
  // the generator and api-check reading the document differently.
  test("requests.json is what the pinned document gives", () => {
    const doc = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
    expect(requestShapes(doc, OPERATIONS.map((o) => o.id))).toEqual(pinned);
    expect(Object.keys(pinned)).toHaveLength(OPERATIONS.length);
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

  test("the same document has no drift", () => {
    expect(requestDrift(pinned, pinned)).toEqual([]);
  });
});
