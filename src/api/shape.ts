// The request side of an operation: every parameter and top-level body field
// it takes, keyed "<in>.<name>" (path.id, query.status, body.title), with
// whether it is required. api-check compares these between the document the
// client was generated from and the server's, because an operation id that is
// still there says nothing about a field the server renamed.
export type RequestShape = Record<string, boolean>;

type Node = Record<string, any>;

export const requestShapes = (doc: Node, ids: Iterable<string>): Record<string, RequestShape> => {
  const wanted = new Set(ids);
  const shapes: Record<string, RequestShape> = {};
  for (const item of Object.values<Node>(doc.paths ?? {})) {
    for (const op of Object.values<Node>(item ?? {})) {
      const id = op?.operationId;
      if (typeof id !== "string" || !wanted.has(id) || shapes[id] !== undefined) continue;
      shapes[id] = shapeOf(doc, op);
    }
  }
  return shapes;
};

const shapeOf = (doc: Node, op: Node): RequestShape => {
  const shape: RequestShape = {};
  for (const raw of op.parameters ?? []) {
    const p = deref(doc, raw);
    if (typeof p?.name === "string") shape[`${p.in}.${p.name}`] = p.required === true;
  }
  const body = deref(doc, op.requestBody);
  const schema = deref(doc, body?.content?.["application/json"]?.schema);
  const required = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
  for (const name of Object.keys(schema?.properties ?? {})) shape[`body.${name}`] = required.has(name);
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

// What would break a call this client makes: a field it may send that the
// server no longer takes, or one the server now requires that the client does
// not know to send (or treats as optional). A field the server added as
// optional, or relaxed to optional, breaks nothing and is left out.
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
  return drift.sort((a, b) => (a.id + a.field < b.id + b.field ? -1 : 1));
};
