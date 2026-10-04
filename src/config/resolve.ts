import { loadGlobal, globalPath, activeProfile, workspaceForOwner, projectsForRepo, type GlobalConfig, type Profile } from "./global";
import { findLocals, mergeLocals, type Local } from "./local";
import { currentRepo } from "./repo";

// The hosted Kaneo instance. A self-hosted deployment is selected through a
// profile, KANEO_API_URL or --api-url.
export const DEFAULT_API_URL = "https://cloud.kaneo.app";

// Which layer a resolved value came from, so `kaneo context` can explain itself
// and a surprising value can be traced back to where it was written down.
export type Source = "flag" | "env" | "local" | "profile" | "repo-map" | "owner-map" | "default" | "unset";

export type Flags = { apiUrl: string; apiKey: string; workspaceId: string; projectId: string };

export type Resolved = {
  apiUrl: string;
  apiKey: string;
  workspaceId: string;
  // A list because the repo map can tie one repository to several projects.
  // Every other layer names exactly one and contributes a one-element list, so a
  // caller reads one field either way; null means no layer answered, which the
  // JSON report prints as null the way Go prints a nil slice.
  projectIds: string[] | null;
  origin: Record<string, Source>;
  profileName: string;
  localPath: string;
  repo: string;
};

export type Input = {
  flags: Flags;
  env: (name: string) => string;
  // Where the .kaneo.json walk starts, and the directory it stops at. A null
  // dir leaves the layer out, and there is then nothing for home to bound.
  dir: string | null;
  home: string;
  global: GlobalConfig;
  repo: string;
};

// What a run that walks no .kaneo.json at all resolves to: this layer names
// nothing and reports no file.
const NO_LOCAL: Local = { workspace: "", project: "", path: "" };

// The precedence chain, from strongest to weakest:
//
//	flag > environment > .kaneo.json > active profile > repo map / owner map > default
//
// Not every layer answers every setting, so the chain is shorter for some:
//
//	api url    flag, environment, profile, default
//	api key    flag, environment, profile
//	workspace  flag, environment, .kaneo.json, profile, owner map
//	project    flag, environment, .kaneo.json, profile, repo map
//
// The last two layers are narrow on purpose. The repo map names the projects a
// repository is tied to and nothing else; the owner map names the workspace an
// owner's repositories belong to and nothing else. Neither can supply a
// credential, and .kaneo.json cannot either — it is a file meant to be
// committed.
export const resolve = (input: Input): Resolved => {
  const { env } = input;
  const local = input.dir === null ? NO_LOCAL : mergeLocals(findLocals(input.dir, input.home));
  const active = activeProfile(input.global);
  const profile: Profile = active?.profile ?? {};
  const fromOwnerMap = input.repo === "" ? "" : workspaceForOwner(input.global, input.repo);
  const fromRepoMap = projectsForRepo(input.global, input.repo);

  const origin: Record<string, Source> = {};
  const pick = (field: string, candidates: [string, Source][]): string => {
    for (const [value, source] of candidates) {
      if (value !== "") {
        origin[field] = source;
        return value;
      }
    }
    origin[field] = "unset";
    return "";
  };
  const pickList = (field: string, candidates: [string[], Source][]): string[] | null => {
    for (const [value, source] of candidates) {
      if (value.length > 0) {
        origin[field] = source;
        return value;
      }
    }
    origin[field] = "unset";
    return null;
  };
  const one = (value: string): string[] => (value === "" ? [] : [value]);

  return {
    apiUrl: pick("api_url", [
      [input.flags.apiUrl, "flag"],
      [env("KANEO_API_URL"), "env"],
      [profile.apiUrl ?? "", "profile"],
      [DEFAULT_API_URL, "default"],
    ]),
    apiKey: pick("api_key", [
      [input.flags.apiKey, "flag"],
      [env("KANEO_API_KEY"), "env"],
      [profile.apiKey ?? "", "profile"],
    ]),
    workspaceId: pick("workspace", [
      [input.flags.workspaceId, "flag"],
      [env("KANEO_WORKSPACE"), "env"],
      [local.workspace, "local"],
      [profile.workspaceId ?? "", "profile"],
      [fromOwnerMap, "owner-map"],
    ]),
    projectIds: pickList("project", [
      [one(input.flags.projectId), "flag"],
      [one(env("KANEO_PROJECT")), "env"],
      [one(local.project), "local"],
      [one(profile.projectId ?? ""), "profile"],
      [fromRepoMap, "repo-map"],
    ]),
    origin,
    profileName: active?.name ?? "",
    localPath: local.path,
    repo: input.repo,
  };
};

// Reads the surroundings of this process and applies the chain.
export const resolveFromEnvironment = (flags: Flags): { cfg: Resolved; global: GlobalConfig } => {
  const env = (name: string): string => process.env[name] ?? "";
  const home = env("HOME");
  if (home === "") throw new Error("$HOME is not defined");
  const global = loadGlobal(globalPath(home, env));
  return { cfg: resolve({ flags, env, dir: process.cwd(), home, global, repo: currentRepo(process.cwd()) }), global };
};

// The same chain for a repository the caller named instead of one read from a
// working copy, and with the .kaneo.json layer left out.
//
// The walk starts from the directory the caller is standing in, and naming
// another repository is saying that directory is not the point. Flags, the
// environment and the active profile still sit above the maps, and the origins
// say which layer answered: a caller asking what the maps hold reads
// origin.project == "repo-map", and with the environment emptied a profile with
// project_id set still answers in their place.
//
// Nor is this what a checkout of that repository resolves to: there the
// .kaneo.json files from the checkout up to home would apply.
export const resolveForRepo = (flags: Flags, global: GlobalConfig, repo: string): Resolved => {
  const env = (name: string): string => process.env[name] ?? "";
  return resolve({ flags, env, dir: null, home: "", global, repo });
};
