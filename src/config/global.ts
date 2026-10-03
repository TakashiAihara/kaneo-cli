import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decode, parse, STRING, stringMap, type GoType } from "./json";

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

// The Go types the file is decoded into. Their names are the ones a decode
// error quotes, so they are the Go spelling rather than this file's.
const PROFILE: GoType = {
  at: "struct",
  name: "Profile",
  fields: [
    { name: "api_url", type: STRING },
    { name: "api_key", type: STRING },
    { name: "workspace_id", type: STRING },
    { name: "project_id", type: STRING },
  ],
};

// A repo map entry holds either a project id or a list of them, because every
// config written before the list existed holds a bare string. Go tries both
// shapes and says so when neither fits.
const PROJECT_IDS: GoType = {
  at: "either",
  name: "ProjectIDs",
  of: [STRING, { at: "slice", value: STRING }],
  complaint: "repo map value must be a project id or a list of project ids",
};

const GLOBAL: GoType = {
  at: "struct",
  name: "Global",
  fields: [
    { name: "default_profile", type: STRING },
    { name: "profiles", type: stringMap(PROFILE) },
    { name: "repos", type: stringMap(PROJECT_IDS) },
    { name: "owners", type: stringMap(STRING) },
    { name: "hooks", type: stringMap(STRING) },
  ],
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
// reading it as empty is how a key stops working without anyone noticing, and
// the Go build stopped with the decoder's own words for both reasons.
export const loadGlobal = (path: string): GlobalConfig => {
  if (!existsSync(path)) return { path };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`read ${path}: ${(e as Error).message}`);
  }
  let file: File;
  try {
    file = decode(parse(text), GLOBAL) as File;
  } catch (e) {
    throw new Error(`parse ${path}: ${(e as Error).message}`);
  }

  return {
    path,
    defaultProfile: file.default_profile ?? undefined,
    profiles: Object.fromEntries(
      Object.entries(file.profiles ?? {}).map(([name, p]) => [
        name,
        {
          apiUrl: p.api_url ?? undefined,
          apiKey: p.api_key ?? undefined,
          workspaceId: p.workspace_id ?? undefined,
          projectId: p.project_id ?? undefined,
        },
      ]),
    ),
    repos: file.repos ?? undefined,
    owners: file.owners ?? undefined,
    hooks: file.hooks ?? undefined,
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
