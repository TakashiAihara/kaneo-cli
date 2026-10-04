import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// The per-directory config a repository may carry. It deliberately holds no
// credentials: the file is meant to be committed, so anything secret in it would
// leak with the repository.

const LOCAL_FILE_NAME = ".kaneo.json";

export type Local = { workspace: string; project: string; path: string };

// Every .kaneo.json from dir towards stopAt, nearest first.
//
// stopAt bounds the walk (normally $HOME) and is itself inspected. When dir is
// not inside stopAt the walk covers dir alone: continuing would run to the
// filesystem root, where a stray .kaneo.json belonging to nobody in particular
// could name a workspace and send later writes to the wrong board.
//
// An unreadable or malformed file is skipped rather than failing the walk. A
// broken config should not stop a session, and the layer below it is still a
// valid answer.
export const findLocals = (dir: string, stopAt: string): Local[] => {
  const found: Local[] = [];
  let here = resolve(dir);
  const stop = resolve(stopAt);
  const bounded = within(here, stop);
  for (;;) {
    const local = readLocal(join(here, LOCAL_FILE_NAME));
    if (local !== undefined) found.push(local);
    if (!bounded || here === stop) break;
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  return found;
};

// Whether dir is root or sits underneath it.
const within = (dir: string, root: string): boolean => {
  const rel = relative(root, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
};

const sep = "/";

const readLocal = (path: string): Local | undefined => {
  try {
    if (statSync(path).isDirectory()) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const file = parsed as { workspace?: unknown; project?: unknown };
    return {
      workspace: typeof file.workspace === "string" ? file.workspace : "",
      project: typeof file.project === "string" ? file.project : "",
      path,
    };
  } catch {
    return undefined;
  }
};

// Folds a nearest-first list into one value, so the nearest definition of each
// field wins and a parent can fill a gap the child left, which is what makes
// this useful in a monorepo.
export const mergeLocals = (locals: Local[]): Local => {
  const out: Local = { workspace: "", project: "", path: "" };
  for (const local of locals) {
    if (out.workspace === "" && local.workspace !== "") {
      out.workspace = local.workspace;
      // Only the first file to contribute anything is recorded, and never
      // overwritten: the path answers "which file did this come from", and the
      // list is nearest-first, so a parent overwriting it would name a file the
      // reader did not get their project from.
      if (out.path === "") out.path = local.path;
    }
    if (out.project === "" && local.project !== "") {
      out.project = local.project;
      if (out.path === "") out.path = local.path;
    }
  }
  return out;
};
