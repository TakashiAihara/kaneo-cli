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
    if (typeof p?.name !== "string" || p.in === "path") continue;
    // Header names are case-insensitive on the wire.
    const name = p.in === "header" ? p.name.toLowerCase() : p.name;
    shape[`${p.in}.${name}`] = p.required === true;
  }
  // Every body in the Kaneo documents measured (2.20 to 2.29) is a plain
  // object; allOf / oneOf / anyOf would read as no fields, so every pinned
  // field shows as drift rather than going unnoticed.
  const body = deref(doc, op.requestBody);
  const schema = deref(doc, body?.content?.["application/json"]?.schema);
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  for (const name of Object.keys(schema?.properties ?? {})) shape[`body.${name}`] = required.has(name);
  // A required name need not be listed under properties to be required.
  for (const name of required) shape[`body.${name}`] = true;
  return shape;
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
