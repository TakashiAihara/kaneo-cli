import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Marker, State } from "./marker";
import { compact, type Json } from "../output/json";

// Which task the current session took, kept so that closing it later does not
// need the task named again.
export type Attachment = {
  taskId: string;
  number: number;
  title: string;
  // The board the task is on, so a reader (a statusline redrawn on every prompt)
  // can name it without an API call. Taken from the task, not the cwd: a
  // session working in another repo would otherwise be shown a confident, wrong
  // project.
  //
  // Each is left out when unknown, as in an attachment written before these
  // existed: absent, never "". A failed lookup leaves out only what it would
  // have filled. All five are a snapshot at attach time: names go stale on
  // rename, and the ids on moving the task to another project. The slug is what
  // the task reference people write is made of, so a reader can print
  // "<slug>#<number>" rather than only an id.
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  workspaceId?: string;
  workspaceName?: string;
};

export type Store = {
  // Where this implementation writes.
  dir: string;
  // Read when dir has no record. The Python implementation keeps its state
  // elsewhere, so a session it attached can still be closed from here during the
  // changeover.
  legacyDirs: string[];
};

// The store rooted at the user's config directory.
export const defaultStore = (home: string, env: (name: string) => string): Store => {
  const configured = env("XDG_CONFIG_HOME");
  const configHome = configured === "" ? join(home, ".config") : configured;
  return { dir: join(configHome, "kaneo", "sessions"), legacyDirs: [join(configHome, "kn", "sessions")] };
};

// The store this process reads and writes. Go's os.UserHomeDir failing fell back
// to the working directory, which lands on the same relative path.
export const sessionStore = (): Store =>
  defaultStore(process.env.HOME ?? ".", (name) => process.env[name] ?? "");

// Reports the session this process belongs to.
//
// KANEO_SESSION_ID comes first so the CLI is usable outside Claude Code; the
// agent-specific variable is the fallback.
export const currentId = (env: (name: string) => string): string => {
  const id = env("KANEO_SESSION_ID").trim();
  return id === "" ? env("CLAUDE_CODE_SESSION_ID").trim() : id;
};

// Rejects anything that could escape the store.
//
// The id arrives from the environment, so it is not this program's to trust.
// Joining resolves ".." rather than refusing it, which would let an id like
// "../../x" read, overwrite and delete files anywhere the process can reach.
// ".." is rejected outright rather than sanitised: a silently rewritten id would
// point at a different session's file.
const BAD_ID = "session id may not contain a path separator or a path element of . or ..";

const validSessionId = (id: string): boolean =>
  id !== "" && id !== "." && id !== ".." && !/[/\\]/.test(id) && !id.includes("..");

const at = (dir: string, sessionId: string): string => join(dir, `${sessionId}.json`);

// Records an attachment for a session.
export const save = (store: Store, sessionId: string, attachment: Attachment): void => {
  if (sessionId === "") throw new Error("no session id");
  if (!validSessionId(sessionId)) throw new Error(BAD_ID);
  mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  // Written aside and renamed into place: a statusline reads this file on every
  // redraw, and a plain write can be caught half-written.
  const aside = join(store.dir, `${sessionId}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(aside, compact(attachment), { mode: 0o600 });
    renameSync(aside, at(store.dir, sessionId));
  } catch (e) {
    rmSync(aside, { force: true });
    throw e;
  }
};

type Read =
  | { kind: "read"; attachment: Attachment }
  // No record here at all, which is what sends the lookup to the next place.
  | { kind: "missing" }
  // A record that is there and cannot be used: unreadable, or not JSON.
  | { kind: "unusable" };

const read = (file: string): Read => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return (e as { code?: string }).code === "ENOENT" ? { kind: "missing" } : { kind: "unusable" };
  }
  try {
    return { kind: "read", attachment: JSON.parse(text) as Attachment };
  } catch {
    return { kind: "unusable" };
  }
};

// Returns the attachment for a session, or undefined.
//
// The current record is authoritative: falling back to a legacy directory after
// failing to read or parse it would hand back a stale attachment, and the next
// close would act on whatever task that named.
export const load = (store: Store, sessionId: string): Attachment | undefined => {
  if (!validSessionId(sessionId)) return undefined;
  const current = read(at(store.dir, sessionId));
  if (current.kind !== "missing") return current.kind === "read" ? current.attachment : undefined;
  for (const dir of store.legacyDirs) {
    const legacy = read(at(dir, sessionId));
    if (legacy.kind === "read") return legacy.attachment;
  }
  return undefined;
};

// Removes the attachment from every location it may live in.
export const clear = (store: Store, sessionId: string): void => {
  if (!validSessionId(sessionId)) return;
  for (const dir of [store.dir, ...store.legacyDirs]) rmSync(at(dir, sessionId), { force: true });
};

const historyAt = (dir: string, sessionId: string): string => join(dir, `${sessionId}.history.jsonl`);

// The board an attachment names, in the order it is written and only as far as it
// was known: a field left out says "not known then", which a reader can act on,
// where "" would say the board had no name.
const boardFields = (attachment: Attachment): Record<string, Json | undefined> => ({
  projectId: attachment.projectId,
  projectName: attachment.projectName,
  projectSlug: attachment.projectSlug,
  workspaceId: attachment.workspaceId,
  workspaceName: attachment.workspaceName,
});

// One line of the history: what the session did, to which task, and on which
// board. The board is copied from the attachment rather than looked up again, so
// a line is a record of what was known at the moment rather than what a later
// rename would call it.
const historyLine = (event: "attach" | "close", attachment: Attachment, at: string): Json => ({
  event,
  at,
  taskId: attachment.taskId,
  number: attachment.number,
  title: attachment.title,
  ...boardFields(attachment),
});

// Appends one event to a session's history and keeps the lines already there.
//
// A session is attached and closed more than once, and a retro running after the
// last close has to be able to see that it ever held anything. Close leaves this
// file alone, because the attachment stays the record of what is held *now* —
// other tools read it that way and have to keep seeing nothing after a close —
// and this is the record of what was.
export const appendHistory = (
  store: Store,
  sessionId: string,
  event: "attach" | "close",
  attachment: Attachment,
  at: Date,
): void => {
  if (sessionId === "") throw new Error("no session id");
  if (!validSessionId(sessionId)) throw new Error(BAD_ID);
  mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  // Not written aside and renamed as the attachment is: that would rewrite the
  // whole file per event. A line cut short by a crash is skipped by the reader,
  // and starting on a fresh line keeps this event from being glued onto it.
  const file = historyAt(store.dir, sessionId);
  const line = `${compact(historyLine(event, attachment, at.toISOString()))}\n`;
  appendFileSync(file, endsCut(file) ? `\n${line}` : line, { mode: 0o600 });
};

// Whether the file's last line has no newline, as a crash mid-write leaves it.
const endsCut = (file: string): boolean => {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
};

// A session's attach history, oldest first: the file is only ever appended to,
// so what is in it is in the order it happened.
//
// A line that cannot be read is counted rather than thrown: the history is what
// is left of an attachment once it is closed, and refusing to show what was read
// because one line is damaged would hide the rest of it. A file that is not there
// at all is not a failure either, since most sessions never attach.
export const readHistory = (store: Store, sessionId: string): { entries: Json[]; skipped: number } => {
  const none = { entries: [], skipped: 0 };
  if (!validSessionId(sessionId)) return none;
  let text: string;
  try {
    text = readFileSync(historyAt(store.dir, sessionId), "utf8");
  } catch {
    return none;
  }
  const entries: Json[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // The trailing newline leaves one empty piece, which is not a damaged line.
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    // Valid JSON that is not an object ("null", "3") is as unreadable as a
    // broken line: a reader indexes every entry by its fields.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) entries.push(parsed as Json);
    else skipped++;
  }
  return { entries, skipped };
};

// Builds a marker for the current process: its session, host, working directory
// and branch.
// The next step and the timestamp are the caller's to fill in: this is what the
// process itself knows, which is everything but those two.
export const describe = (env: (name: string) => string, dir: string, state: State): Marker => ({
  sessionId: currentId(env),
  host: hostname(),
  cwd: dir,
  branch: currentBranch(dir),
  state,
  nextStep: "",
  createdAt: "",
});

// Bounds the git call. The branch name is a nicety on a marker, so waiting for
// it is never worth stalling the caller.
const BRANCH_TIMEOUT_MS = 2_000;

const currentBranch = (dir: string): string => {
  // A deadline rather than a bare run: git can block indefinitely on an
  // unresponsive network mount or waiting for credentials, and this runs from a
  // session-start hook. Fail-open covers errors, not hangs.
  try {
    const git = Bun.spawnSync(["git", "branch", "--show-current"], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: BRANCH_TIMEOUT_MS,
    });
    return git.success ? git.stdout.toString().trim() : "";
  } catch {
    return "";
  }
};