import { readFileSync } from "node:fs";
import { SPEC_PATH } from "../../openapi/spec";

// The content types the pinned document declares for each operation's error
// statuses, so a reply the fake sends can be checked against what the server
// it imitates declares. Only statuses the document gives a `content` for are
// checked: a status it lists without one (the shared 401, a 304) documents no
// body, and the wire format there is the server's own choice — an
// HTTPException's text or a route's c.json — which the routes answer as they
// answer.

type SpecResponse = { content?: Record<string, unknown> };
type SpecOperation = { responses?: Record<string, SpecResponse> };
type SpecDoc = { paths: Record<string, Record<string, SpecOperation>> };

let operations: { method: string; segments: string[]; responses: Record<string, SpecResponse> }[] | undefined;

const load = () => {
  if (operations !== undefined) return operations;
  const doc = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as SpecDoc;
  operations = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      operations.push({
        method: method.toUpperCase(),
        segments: path.split("/").filter((s) => s !== ""),
        responses: operation.responses ?? {},
      });
    }
  }
  return operations;
};

// The media types the document declares for this method, path and status, or
// undefined when the document does not pin the reply's content type: no
// operation matches the path, the status is not declared, or it is declared
// without content.
export const declaredErrorTypes = (method: string, path: string, status: number): string[] | undefined => {
  const segments = path.split("/").filter((s) => s !== "");
  const operation = load().find(
    (op) =>
      op.method === method.toUpperCase() &&
      op.segments.length === segments.length &&
      op.segments.every((seg, i) => (seg.startsWith("{") && seg.endsWith("}")) || seg === segments[i]),
  );
  if (operation === undefined) return undefined;
  const response = operation.responses[String(status)];
  const content = response?.content;
  if (content === undefined) return undefined;
  return Object.keys(content).map((t) => t.toLowerCase());
};
