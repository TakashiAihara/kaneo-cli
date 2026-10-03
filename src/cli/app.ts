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
  timeoutMs: number;
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
