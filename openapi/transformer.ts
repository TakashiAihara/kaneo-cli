import type { OpenAPIObject } from "openapi3-ts/oas30";
import { OPERATIONS } from "../src/api/registry";

// Orval filters by tag or schema only, so the operation filter lives here:
// everything outside the registry is dropped, then every component no kept
// operation reaches, so the generated models are only what the CLI decodes.
const keep = new Set(OPERATIONS.map((op) => op.id));
const METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

export default (doc: OpenAPIObject): OpenAPIObject => {
  correctOrganization(doc);
  correctLabel(doc);

  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = (item as any)[method];
      if (op && !keep.has(op.operationId)) delete (item as any)[method];
    }
    if (!METHODS.some((m) => (item as any)[m])) delete doc.paths[path];
  }

  pruneComponents(doc);
  return doc;
};

// better-auth's organization routes are documented with empty schemas, so the
// workspace listing and rename would decode to nothing. The server answers
// with the organization itself. REMOVE WHEN the upstream document gives these
// two responses a schema.
function correctOrganization(doc: OpenAPIObject) {
  const ref = { $ref: "#/components/schemas/Organization" };
  doc.components ??= {};
  doc.components.schemas ??= {};
  doc.components.schemas.Organization = {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" }, slug: { type: "string" } },
    required: ["id", "name", "slug"],
  };
  const json = (op: any) => op.responses["200"].content["application/json"];
  json(doc.paths["/auth/organization/list"].get).schema.items = ref;
  json(doc.paths["/auth/organization/update"].post).schema = ref;
}

// The server sends deletionStartedAt as null on every label not being deleted
// (apps/api/src/label/response.ts declares it nullable), but the published
// document drops the null, so every label reply fails the schema check that
// KANEO_DEBUG reports. REMOVE WHEN the upstream document marks it nullable.
function correctLabel(doc: OpenAPIObject) {
  const field = (doc.components?.schemas?.Label as any)?.properties?.deletionStartedAt;
  // Missing means the document changed shape, and this correction would stop
  // applying without anyone noticing.
  if (!field) throw new Error("openapi/transformer.ts: Label.deletionStartedAt is gone from the document; revisit correctLabel");
  field.type = ["string", "null"];
}

function pruneComponents(doc: OpenAPIObject) {
  const reached = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && !reached.has(v)) {
        reached.add(v);
        const [, , section, name] = v.split("/");
        walk((doc.components as any)?.[section]?.[name]);
      } else walk(v);
    }
  };
  walk(doc.paths);

  for (const [section, entries] of Object.entries(doc.components ?? {})) {
    for (const name of Object.keys(entries as object)) {
      if (!reached.has(`#/components/${section}/${name}`)) delete (entries as any)[name];
    }
  }
}
