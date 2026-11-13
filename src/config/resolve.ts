import { loadGlobal, globalPath, activeProfile, workspaceForOwner, projectsForRepo, type GlobalConfig, type Profile } from "./global";
import { findLocals, mergeLocals, type Local } from "./local";
import { currentRepo } from "./repo";

// The hosted Kaneo instance. A self-hosted deployment is selected through a
// profile, KANEO_API_URL or --api-url.
const DEFAULT_API_URL = "https://cloud.kaneo.app";

// Which layer a resolved value came from, so `kaneo context` can explain itself
// and a surprising value can be traced back to where it was written down.
type Source = "flag" | "env" | "local" | "profile" | "command" | "repo-map" | "owner-map" | "default" | "unset";

// api_key_command keeps the key out of the config file and out of the
// environment of everything else the caller runs: the command (e.g.
// `inf-run -- printenv KANEO_API_KEY`) is asked for the key only when no
// stronger layer has one, and only once per process, because resolveForRepo
// runs the chain again.
const COMMAND_TIMEOUT_MS = 30_000;
const commandKeys = new Map<string, string>();

const runKeyCommand = (command: string): string => {
  const cached = commandKeys.get(command);
  if (cached !== undefined) return cached;

  // stdin is not passed on: some commands read a secret or a document from it,
  // and the key command must not consume it first. stderr is, so the command's
  // own complaint reaches the user; only stdout carries the key.
  const run = Bun.spawnSync(["sh", "-c", command], {
    env: process.env,
    timeout: COMMAND_TIMEOUT_MS,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (run.exitedDueToTimeout) throw new Error(`api_key_command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`);
  if (!run.success) throw new Error(`api_key_command failed (exit ${run.exitCode ?? "signal"})`);

  const key = run.stdout.toString().trim();
  if (key === "") throw new Error("api_key_command printed nothing");
  // The value goes into an Authorization header, and an HTTP library quotes a
  // header value it refuses in its error, so a bad one is refused here without
  // being printed.
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error("api_key_command printed a value that is not a single-line API key");

  commandKeys.set(command, key);
  return key;
};

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

type Input = {
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
//	api key    flag, environment, profile, profile's api_key_command
//	workspace  flag, environment, .kaneo.json, profile, owner map
//	project    flag, environment, .kaneo.json, profile, repo map
//
// The last two layers are narrow on purpose. The repo map names the projects a
// repository is tied to and nothing else; the owner map names the workspace an
// owner's repositories belong to and nothing else. Neither can supply a
// credential, and .kaneo.json cannot either — it is a file meant to be
// committed.
const resolve = (input: Input): Resolved => {
  const { env } = input;
  const local = input.dir === null ? NO_LOCAL : mergeLocals(findLocals(input.dir, input.home));
  const active = activeProfile(input.global);
  const profile: Profile = active?.profile ?? {};
  const fromOwnerMap = input.repo === "" ? "" : workspaceForOwner(input.global, input.repo);
  const fromRepoMap = projectsForRepo(input.global, input.repo);

  const origin: Record<string, Source> = {};
  // A candidate given as a function is only evaluated when every stronger one
  // was empty.
  const pick = (field: string, candidates: [string | (() => string), Source][]): string => {
    for (const [candidate, source] of candidates) {
      const value = typeof candidate === "function" ? candidate() : candidate;
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
      [() => (profile.apiKeyCommand ? runKeyCommand(profile.apiKeyCommand) : ""), "command"],
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
