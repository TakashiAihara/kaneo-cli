import { parseRepo } from "../config/repo";
import { resolveForRepo, type Resolved } from "../config/resolve";
import type { RunContext } from "./args";
import type { App } from "./app";

// What the resolution chain settled on, and which layer supplied each value.
// The key itself is never printed: this is the command someone runs before
// asking for help, and its output must be safe to paste anywhere.
//
// The field names are the output's, and a field no layer filled in is left out
// entirely rather than printed empty.
type Report = {
  api_url: string;
  workspace: string;
  // null when no layer named a project, which is what the Go build printed for
  // a nil slice: the field is always there and its emptiness is the answer.
  projects: string[] | null;
  repo?: string;
  profile?: string;
  local_file?: string;
  config_file?: string;
  has_api_key: boolean;
  origin: Record<string, string>;
};

const or = (value: string, fallback: string): string => (value === "" ? fallback : value);
const omitted = (value: string): string | undefined => (value === "" ? undefined : value);

// The chain as it is run for the repository a caller named rather than the one
// this directory's remote names. Only context takes --repo, so no other command
// resolves differently.
//
// A value that names no repository is refused rather than read as an empty one:
// an empty repo falls through to the weaker layers without saying so, and the
// maps --repo exists to answer would then be the only ones left asking.
const forRepo = (value: string, app: App): Resolved => {
  const repo = parseRepo(value);
  if (repo === "") throw new Error(`--repo wants owner/name, got ${JSON.stringify(value)}`);
  return resolveForRepo(app.flags, app.global, repo);
};

export const contextCommand = {
  name: "context",
  short: "Show the resolved settings and where each value came from",
  args: (args: string[]) => {
    const first = args[0];
    if (first !== undefined) {
      throw new Error(`unknown command ${JSON.stringify(first)} for "kaneo context"`);
    }
  },
  flags: [
    {
      name: "repo",
      type: "string" as const,
      usage: "resolve for this repository (owner/name or a remote) instead of the working copy's remote",
      defaultValue: "",
    },
  ],
  run: ({ changed, flags, app }: RunContext<App>) => {
    const cfg = changed.has("repo") ? forRepo(String(flags.repo ?? ""), app) : app.cfg;
    const origin = {
      api_key: cfg.origin.api_key ?? "unset",
      api_url: cfg.origin.api_url ?? "unset",
      project: cfg.origin.project ?? "unset",
      workspace: cfg.origin.workspace ?? "unset",
    };

    app.out.human(`api url    ${or(cfg.apiUrl, "-")}  (${origin.api_url})`);
    app.out.human(`api key    ${cfg.apiKey === "" ? "not set" : "set"}  (${origin.api_key})`);
    app.out.human(`workspace  ${or(cfg.workspaceId, "-")}  (${origin.workspace})`);
    app.out.human(`project    ${or(cfg.projectIds?.join(", ") ?? "", "-")}  (${origin.project})`);
    app.out.human("");
    app.out.human(`repo       ${or(cfg.repo, "-")}`);
    app.out.human(`profile    ${or(cfg.profileName, "-")}`);
    app.out.human(`local file ${or(cfg.localPath, "-")}`);
    app.out.human(`config     ${or(app.global.path, "-")}`);

    const report: Report = {
      api_url: cfg.apiUrl,
      workspace: cfg.workspaceId,
      projects: cfg.projectIds,
      repo: omitted(cfg.repo),
      profile: omitted(cfg.profileName),
      local_file: omitted(cfg.localPath),
      config_file: omitted(app.global.path),
      has_api_key: cfg.apiKey !== "",
      origin,
    };
    app.out.data(report);
  },
};
