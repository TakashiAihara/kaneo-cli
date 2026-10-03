import { writeSync } from "node:fs";
import type { GlobalConfig } from "../config/global";
import type { Resolved } from "../config/resolve";
import type { Writer } from "../output/output";

// Everything a command needs, built once before the command runs and read by
// the leaves. The transport is configured at the same moment, since it is a
// module the generated client imports and has no other way to be told.
export type App = {
  cfg: Resolved;
  global: GlobalConfig;
  out: Writer;
  // The one budget every request of this command shares, as the Go build's
  // app.Context() was one context: a command that looks something up before it
  // writes spends part of the same timeout as the write.
  deadline: AbortSignal;
  // When that budget runs out, so a command sharing it with something else can
  // see what is left of it.
  deadlineAt: number;
};

// The budget --timeout asked for.
//
// A timeout of zero or less is not "no timeout" and not the default: it is a
// deadline that has already passed, so every request under it fails at once. Go
// reads --timeout the same way, through a context.WithTimeout on a duration the
// flag supplied, and this is what a context with no time left behaves like.
export const deadlineFor = (ms: number): { deadline: AbortSignal; deadlineAt: number } => {
  const deadlineAt = Date.now() + ms;
  return { deadline: ms > 0 ? AbortSignal.timeout(ms) : AbortSignal.abort(), deadlineAt };
};

// Half of what is left of the command's budget, for work that must not use up
// what something after it needs: the board lookups an attach shares with the
// marker post get half, as they did when both ran under one context.
export const halfLeft = (app: App): AbortSignal => {
  const left = Math.max(0, (app.deadlineAt - Date.now()) / 2);
  return AbortSignal.any([app.deadline, AbortSignal.timeout(left)]);
};

export const NO_API_KEY = "no API key: set KANEO_API_KEY, or pass --api-key";

export const NO_WORKSPACE =
  "no workspace: pass --workspace, set KANEO_WORKSPACE, or add one to .kaneo.json";

export const NO_PROJECT = "no project: pass --project, set KANEO_PROJECT, or add one to .kaneo.json";

// Every command but api-check needs a credential, and says so here rather than
// letting a request go out without one. api-check reads the document the server
// serves without authentication, so it is the one that works before a key is
// set.
export const apiKey = (app: App): string => {
  if (app.cfg.apiKey === "") throw new Error(NO_API_KEY);
  return app.cfg.apiKey;
};

export const workspace = (app: App): string => {
  if (app.cfg.workspaceId === "") throw new Error(NO_WORKSPACE);
  return app.cfg.workspaceId;
};

// Every project the settings resolved to. Only the repo map can name more than
// one; a flag, the environment, a .kaneo.json and a profile each name exactly
// one.
export const projects = (app: App): string[] => {
  const ids = app.cfg.projectIds;
  if (ids === null || ids.length === 0) throw new Error(NO_PROJECT);
  return ids;
};

// The single project a command should act on.
//
// A repository tied to several projects has no single answer, and taking the
// first would write to a board nobody named. The entries are ordered, but the
// order says only how they were written down — no entry is marked as the one to
// write to — so treating the first as a default would invent a rule nobody
// stated. The caller has to say which. This is the same reason the owner map
// supplies a workspace but never a project.
export const project = (app: App): string => {
  const ids = projects(app);
  if (ids.length > 1) {
    throw new Error(
      `${app.cfg.repo === "" ? "this repository" : app.cfg.repo} is mapped to ${ids.length} projects (${ids.join(", ")}): pass --project or set KANEO_PROJECT to choose one`,
    );
  }
  return ids[0]!;
};

// The project a command reads a task out of, or "" when the settings name none
// or several.
//
// The Go build dropped the error from project() and passed the empty string on,
// because a task reference can be an id as well as a number, and only a number
// needs a project to look through. The leniency is kept, and the lookup is what
// reports the missing project, naming the number it could not resolve.
export const taskProject = (app: App): string => {
  const ids = app.cfg.projectIds ?? [];
  return ids.length === 1 ? ids[0]! : "";
};

// Writes to stderr only when KANEO_DEBUG is set. It exists so the fail-open
// commands can explain themselves without breaking their contract of producing
// no output.
export const debug = (message: string): void => {
  if ((process.env.KANEO_DEBUG ?? "") === "") return;
  writeSync(2, `kaneo: ${message}\n`);
};
