// The request side of an operation: its query and header parameters and its
// top-level JSON body fields, keyed "<in>.<name>" (query.status, body.title),
// with whether each is required. api-check compares these between the document
// the client was generated from and the server's, because an operation id that
// is still there says nothing about a field the server renamed.
//
// Path parameters are left out: the generated client fills the path template
// by position, so a renamed one changes nothing on the wire. Nested fields,
// types and enums are not compared either; this catches renamed, removed and
// newly required fields, the kind PR #38 found by hand.
export type RequestShape = Record<string, boolean>;

type Node = Record<string, any>;

export const requestShapes = (doc: Node, ids: Iterable<string>): Record<string, RequestShape> => {
  const wanted = new Set(ids);
  const shapes: Record<string, RequestShape> = {};
  for (const item of Object.values<Node>(doc.paths ?? {})) {
    for (const op of Object.values<Node>(item ?? {})) {
      const id = op?.operationId;
      if (typeof id !== "string" || !wanted.has(id) || shapes[id] !== undefined) continue;
      shapes[id] = shapeOf(doc, item, op);
    }
  }
  return shapes;
};

const shapeOf = (doc: Node, item: Node, op: Node): RequestShape => {
  const shape: RequestShape = {};
  // Path-level parameters apply to every operation under the path; the
  // operation's own entry for the same name and location replaces it.
  for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = deref(doc, raw);
    if (typeof p?.name === "string" && p.in !== "path") shape[`${p.in}.${p.name}`] = p.required === true;
  }
  const body = deref(doc, op.requestBody);
  for (const [name, required] of fieldsOf(doc, body?.content?.["application/json"]?.schema, 0)) {
    shape[`body.${name}`] = required;
  }
  return shape;
};

// A body schema's top-level fields. allOf merges its members (a field is
// required if any member requires it); oneOf and anyOf take every field any
// branch has, required only where every branch requires it, since the client
// may be sending any one of them.
const fieldsOf = (doc: Node, raw: unknown, depth: number): Map<string, boolean> => {
  const schema = deref(doc, raw);
  const fields = new Map<string, boolean>();
  if (!schema || typeof schema !== "object" || depth > 16) return fields;

  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  for (const name of Object.keys(schema.properties ?? {})) fields.set(name, required.has(name));
  for (const name of required) if (!fields.has(name)) fields.set(name, true);

  for (const member of schema.allOf ?? []) {
    for (const [name, req] of fieldsOf(doc, member, depth + 1)) fields.set(name, req || fields.get(name) === true);
  }
  for (const key of ["oneOf", "anyOf"]) {
    const branches = (schema[key] ?? []).map((b: unknown) => fieldsOf(doc, b, depth + 1)) as Map<string, boolean>[];
    for (const name of new Set(branches.flatMap((b) => [...b.keys()]))) {
      const everywhere = branches.every((b) => b.get(name) === true);
      fields.set(name, fields.get(name) === true || everywhere);
    }
  }
  return fields;
};

// Only local references: both documents keep their schemas under components.
const deref = (doc: Node, node: any): any => {
  for (let hops = 0; typeof node?.$ref === "string" && hops < 16; hops++) {
    node = node.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce((at: any, key: string) => at?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
  }
  return node;
};

// Where the server's request side differs from the pinned document's in a way a
// call could notice: a field the pinned document has that the server's does
// not (the server ignores or refuses it), or one the server requires that the
// pinned document leaves optional or does not have. A field the server added as
// optional, or relaxed to optional, is left out.
//
// The comparison is against the pinned document, not against what the CLI puts
// on the wire: some fields the document offers are never sent, and some it
// calls optional are always sent. So a drift is a lead to check, not proof that
// a command fails, and api-check reports it without failing.
export type Drift = { id: string; field: string; problem: "gone" | "required" };

export const requestDrift = (
  client: Record<string, RequestShape>,
  server: Record<string, RequestShape>,
): Drift[] => {
  const drift: Drift[] = [];
  for (const [id, mine] of Object.entries(client)) {
    const theirs = server[id];
    // An operation missing from the server is reported as missing already.
    if (theirs === undefined) continue;
    for (const field of Object.keys(mine)) {
      if (!(field in theirs)) drift.push({ id, field, problem: "gone" });
    }
    for (const [field, required] of Object.entries(theirs)) {
      if (required && mine[field] !== true) drift.push({ id, field, problem: "required" });
    }
  }
  const key = (d: Drift) => `${d.id} ${d.field}`;
  return drift.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
};
