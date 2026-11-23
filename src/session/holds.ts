import { z } from "zod";
import {
  createCustomField,
  listCustomFields,
  listTaskFieldValues,
  setCustomFieldValue,
  type CustomField,
  type CustomFieldValue,
} from "../api/kaneo";
import { KaneoApiError } from "../api/http";
import { hard } from "../cli/failopen";
import { shellWord } from "../output/output";
import { holding, latestPerSession, RUNNING, type Marker } from "./marker";

// The custom field a task's session holds are kept in, one per project. The
// name is this CLI's convention: nothing upstream defines a session field,
// so a field a person made under the same name is what the holds then are —
// which is why a non-text one is refused rather than overwritten.
const SESSION_FIELD = "kaneo-session";

// One session's hold as the field carries it: the marker's own fields plus
// the time of the write, which stands in for the comment's createdAt when
// holds and markers are merged. `at` is when the hold was last written, not
// when the session attached — a `session next` rewrites it.
export type SessionHold = {
  sessionId: string;
  host: string;
  cwd: string;
  branch: string;
  nextStep: string;
  at: string;
};

const Hold = z.object({
  sessionId: z.string(),
  host: z.string(),
  cwd: z.string(),
  branch: z.string(),
  nextStep: z.string(),
  at: z.string(),
});
const HoldList = z.array(Hold);

// The field value is JSON so every marker field survives verbatim: a next
// step is free text, and the marker's percent-encoding exists only because a
// comment body is not JSON.
export const encodeHolds = (holds: SessionHold[]): string => JSON.stringify(holds);

// Reads a stored value back into holds. A value that is not the JSON this
// CLI writes is a hard stop rather than an empty read: treating it as "no
// holds" would report a held task as free, which is the failure the field
// exists to end.
export const decodeHolds = (value: string | null): SessionHold[] => {
  if (value === null || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`the ${SESSION_FIELD} value is not JSON`);
  }
  const checked = HoldList.safeParse(parsed);
  if (!checked.success) throw new Error(`the ${SESSION_FIELD} value is not a list of session holds`);
  return checked.data;
};

// The router's own 404 is the only answer a custom-field route gives that no
// field handler produces: theirs name the project, task or field that was
// not found instead. It is the whole of the version signal there is — an
// older server answers it for every /custom-field path — and the caller then
// takes the comment-marker path it always had.
const routeMissing = (e: unknown): e is KaneoApiError =>
  e instanceof KaneoApiError && e.statusCode === 404 && e.messages.includes("404 Not Found");

// A project's field definitions, or undefined when the server has no
// custom-field routes. Every other failure is the caller's to report.
export const projectFields = async (projectId: string): Promise<CustomField[] | undefined> => {
  try {
    return await listCustomFields(projectId);
  } catch (e) {
    if (routeMissing(e)) return undefined;
    throw e;
  }
};

// The session field among a project's fields: none when the project never
// had one made, refused when the name is shared or the type cannot keep the
// JSON holds — the same rule `field` keeps for a name two fields share.
export const pickSessionField = (fields: CustomField[], projectId: string): CustomField | undefined => {
  const named = fields.filter((f) => f.name === SESSION_FIELD);
  if (named.length > 1) {
    throw new Error(
      `${named.length} fields are named ${JSON.stringify(SESSION_FIELD)}; session holds cannot tell them apart — rename or delete one (\`kaneo field rm -p ${shellWord(projectId)} --yes ${named[1]!.id}\`)`,
    );
  }
  const field = named[0];
  if (field !== undefined && field.type !== "text") {
    throw new Error(
      `the ${SESSION_FIELD} field is type ${JSON.stringify(field.type)}, not text; session holds are JSON and need a text field — rename or delete it (\`kaneo field rm -p ${shellWord(projectId)} --yes ${field.id}\`)`,
    );
  }
  return field;
};

// The holds one task's session field carries: the value row for the field,
// decoded. A task with no row — the field was never set on it — holds none.
const readHolds = async (taskId: string, fieldId: string): Promise<SessionHold[]> => {
  const row = (await listTaskFieldValues(taskId)).find((v) => v.fieldId === fieldId);
  return decodeHolds(row?.value ?? null);
};

// Stores the holds as the field's value.
export const writeHolds = async (taskId: string, fieldId: string, holds: SessionHold[]): Promise<void> => {
  await setCustomFieldValue(taskId, fieldId, encodeHolds(holds));
};

// Confirms the server kept a session-field write, by listing the task's
// field values and checking the row for the field holds the text that was
// sent — the same check confirmMarker makes on a comment, for the same
// reason: a write the board cannot read back is one this machine must not
// record as done. listingFailure is the caller's call on a listing that
// cannot be made, the same choice the comment path makes.
export const confirmFieldWrite = async (
  taskId: string,
  number: number,
  fieldId: string,
  expected: string,
  listingFailure: "hard" | "fail-open",
): Promise<void> => {
  let values: CustomFieldValue[];
  try {
    values = await listTaskFieldValues(taskId);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const message = `wrote the ${SESSION_FIELD} field on #${number} but could not list the task's field values to confirm it: ${reason}; \`kaneo task field ${shellWord(taskId)}\` shows what is stored`;
    if (listingFailure === "hard") throw hard(message);
    throw new Error(message);
  }
  const row = values.find((v) => v.fieldId === fieldId);
  if (row === undefined) {
    throw hard(
      `wrote the ${SESSION_FIELD} field on #${number} but the task has no value for it; \`kaneo task field ${shellWord(taskId)}\` shows what is stored`,
    );
  }
  if (row.value !== expected) {
    throw hard(
      `wrote the ${SESSION_FIELD} field on #${number} but the server stored different text; \`kaneo task field ${shellWord(taskId)}\` shows what is stored`,
    );
  }
};

export type FieldBacking = { field: CustomField | undefined; holds: SessionHold[] };

// The session field of the project the task is on and the holds it carries
// for the task. `create` makes the field when the project has none — a close
// that only means to remove a hold does not litter a project with an empty
// field. undefined means the server has no custom fields, and the caller
// takes the comment-marker path it always had; a defined answer with no
// field is a project that has not needed one yet.
export const sessionBacking = async (
  taskId: string,
  projectId: string,
  create: boolean,
): Promise<FieldBacking | undefined> => {
  if (projectId === "") return undefined;
  const fields = await projectFields(projectId);
  if (fields === undefined) return undefined;
  let field = pickSessionField(fields, projectId);
  if (field === undefined && create) {
    try {
      field = await createCustomField(projectId, { name: SESSION_FIELD, type: "text", required: false });
    } catch (e) {
      if (routeMissing(e)) return undefined;
      throw e;
    }
  }
  if (field === undefined) return { field: undefined, holds: [] };
  return { field, holds: await readHolds(taskId, field.id) };
};

// The hold a marker describes, stamped with the write's time — the field
// has no comment timestamp to borrow, so `at` is when this write happened.
export const holdOf = (marker: Marker, at: string): SessionHold => ({
  sessionId: marker.sessionId,
  host: marker.host,
  cwd: marker.cwd,
  branch: marker.branch,
  nextStep: marker.nextStep,
  at,
});

// Replaces the hold a session already has and keeps the rest in order; a
// session the list does not name is appended.
export const upsertHold = (holds: SessionHold[], hold: SessionHold): SessionHold[] => {
  const at = holds.findIndex((h) => h.sessionId === hold.sessionId);
  if (at === -1) return [...holds, hold];
  return holds.map((h, i) => (i === at ? hold : h));
};

export const dropHold = (holds: SessionHold[], sessionId: string): SessionHold[] =>
  holds.filter((h) => h.sessionId !== sessionId);

// The sessions holding a task, field first: a session the field names is
// held as the field says it is, and a comment marker counts only for a
// session the field does not name — markers are the fallback for holds
// written before the field existed, not a second source of truth. The
// result is the shape `holding` answers, so every reader treats the two
// storages alike.
export const mergeHolds = (holds: SessionHold[], comments: { content: string; createdAt: string }[]): Marker[] => {
  // A hand-edited value can name one session twice; the later entry is the
  // newer write, the same rule latestPerSession keeps for comments.
  const latest = new Map<string, SessionHold>();
  for (const hold of holds) latest.set(hold.sessionId, hold);
  const fromField = [...latest.values()].map((h): Marker => ({
    sessionId: h.sessionId,
    host: h.host,
    cwd: h.cwd,
    branch: h.branch,
    state: RUNNING,
    nextStep: h.nextStep,
    createdAt: h.at,
  }));
  const named = new Set(fromField.map((m) => m.sessionId));
  const fromComments = holding(comments).filter((m) => !named.has(m.sessionId));
  return latestPerSession([...fromField, ...fromComments]);
};

// The session ids a task's session field names, for the move report that
// lists the sessions an old task's comments carried — the field's holds are
// the same list when the server has custom fields.
export const fieldSessionIds = async (taskId: string, projectId: string): Promise<string[]> => {
  const backing = await sessionBacking(taskId, projectId, false);
  if (backing?.field === undefined) return [];
  const ids: string[] = [];
  for (const hold of backing.holds) {
    if (hold.sessionId !== "" && !ids.includes(hold.sessionId)) ids.push(hold.sessionId);
  }
  return ids;
};

// Carries a task's session holds across a same-workspace move: the value
// rows are keyed to the field and the field to its project, so the row the
// task had stays behind on the old project's field where the new board
// never looks. The holds are written to the destination's session field —
// made when the project has none — so the hold the task had stays visible.
// The old row is left: no route deletes one value, and the reads that count
// only ever ask for the current project's field.
export const moveSessionField = async (taskId: string, fromProjectId: string, toProjectId: string): Promise<void> => {
  if (toProjectId === "") return;
  const source = await sessionBacking(taskId, fromProjectId, false);
  if (source?.field === undefined || source.holds.length === 0) return;
  const fields = await projectFields(toProjectId);
  if (fields === undefined) return;
  let field = pickSessionField(fields, toProjectId);
  if (field === undefined) {
    field = await createCustomField(toProjectId, { name: SESSION_FIELD, type: "text", required: false });
  }
  await writeHolds(taskId, field.id, source.holds);
};
