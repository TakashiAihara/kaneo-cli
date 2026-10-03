import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The user-level config at ~/.config/kaneo/config.json.

export type Profile = {
  apiUrl?: string;
  apiKey?: string;
  workspaceId?: string;
  projectId?: string;
};

export type GlobalConfig = {
  defaultProfile?: string;
  profiles?: Record<string, Profile>;
  // repos maps a git remote's "owner/repo" to the projects it is tied to, and
  // owners maps a remote's owner to a workspace id. The keys are deliberately
  // not paths: a working copy's absolute path differs between machines, while a
  // remote is the same everywhere.
  repos?: Record<string, string | string[]>;
  owners?: Record<string, string>;
  hooks?: Record<string, string>;
  // Where this was loaded from, which `kaneo context` reports.
  path: string;
};

// The file spells its fields in snake_case, which is kept here rather than
// renamed on the way in: the file is written by hand and synced between
// machines, so its spelling is the contract and nothing else should depend on
// it.
type FileProfile = {
  api_url?: string;
  api_key?: string;
  workspace_id?: string;
  project_id?: string;
};

type File = {
  default_profile?: string;
  profiles?: Record<string, FileProfile>;
  repos?: Record<string, string | string[]>;
  owners?: Record<string, string>;
  hooks?: Record<string, string>;
};

export const globalPath = (home: string, env: (name: string) => string): string => {
  const xdg = env("XDG_CONFIG_HOME");
  return xdg === "" ? join(home, ".config", "kaneo", "config.json") : join(xdg, "kaneo", "config.json");
};

const projectIds = (value: string | string[] | undefined): string[] => {
  const many = typeof value === "string" ? [value] : (value ?? []);
  // An empty id is not a project, and letting one through would make a
  // repository look configured while every request built from it named nothing.
  return many.filter((id) => id !== "");
};

// A missing file is not an error: it is an empty config, so a fresh install
// works from flags and environment alone. A malformed one is, because silently
// reading it as empty is how a key stops working without anyone noticing.
export const loadGlobal = (path: string): GlobalConfig => {
  const empty: GlobalConfig = { path };
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`parse ${path}: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`parse ${path}: not an object`);
  }
  const file = parsed as File;
  return {
    path,
    defaultProfile: file.default_profile,
    profiles: Object.fromEntries(
      Object.entries(file.profiles ?? {}).map(([name, p]) => [
        name,
        {
          apiUrl: p.api_url,
          apiKey: p.api_key,
          workspaceId: p.workspace_id,
          projectId: p.project_id,
        },
      ]),
    ),
    repos: file.repos,
    owners: file.owners,
    hooks: file.hooks,
  };
};

// The profile named by default_profile, or the sole profile when exactly one
// exists and no default was recorded.
export const activeProfile = (config: GlobalConfig): { name: string; profile: Profile } | undefined => {
  const profiles = config.profiles ?? {};
  const named = config.defaultProfile;
  if (named !== undefined && named !== "" && profiles[named] !== undefined) {
    return { name: named, profile: profiles[named]! };
  }
  const names = Object.keys(profiles);
  if (names.length === 1) return { name: names[0]!, profile: profiles[names[0]!]! };
  return undefined;
};

export const workspaceForOwner = (config: GlobalConfig, repo: string): string => {
  const slash = repo.indexOf("/");
  if (slash <= 0) return "";
  return config.owners?.[repo.slice(0, slash)] ?? "";
};

export const projectsForRepo = (config: GlobalConfig, repo: string): string[] =>
  repo === "" ? [] : projectIds(config.repos?.[repo]);
