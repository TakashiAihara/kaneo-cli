import type { Seed } from "./fake";

// The behaviour the Go build had when it was retired, as command sequences run
// against tests/parity/fake.ts. scripts/record-golden.ts runs them through the
// Go reference binary and writes tests/parity/golden/; tests/parity/parity.test.ts
// runs them through this build and compares. Each scenario starts from a fresh
// fake seeded with SEED, a fresh HOME, and a cwd outside any repository.

export const WS = "ws-main";
export const P1 = "proj-alpha";
export const P2 = "proj-beta";

export const SEED: Seed = {
  workspaces: [
    { id: WS, name: "Main", slug: "main" },
    { id: "ws-other", name: "Other", slug: "other" },
  ],
  projects: [
    { id: P1, workspaceId: WS, name: "Alpha", slug: "ALP" },
    { id: P2, workspaceId: WS, name: "Beta", slug: "BET" },
    { id: "proj-old", workspaceId: WS, name: "Old", slug: "OLD", archived: true },
  ],
  users: [{ id: "user-1", name: "Ada" }],
  tasks: [
    { id: "task-a1", projectId: P1, title: "Write the parser", priority: "high", description: "multi\nline" },
    { id: "task-a2", projectId: P1, title: "Ship it", status: "in-progress", userId: "user-1" },
    { id: "task-a3", projectId: P1, title: "Old news", status: "done" },
    { id: "task-b1", projectId: P2, title: "Beta first", priority: "urgent" },
  ],
  comments: [{ taskId: "task-a1", content: "first comment" }],
};

export type Scenario = {
  name: string;
  // Each step is one CLI invocation. Global context (-w / -p) is passed in
  // env, the way a session hook sees it.
  steps: string[][];
  env?: Record<string, string>;
  // Seeds a ~/.config/kaneo/config.json before the first step.
  config?: unknown;
  // Writes a .kaneo.json in the parent of the cwd, so the walk-up is exercised.
  local?: unknown;
  // Makes the cwd a git repository whose origin is github.com/<repo>.
  repo?: string;
  pageSize?: number;
};

const both = (name: string, args: string[]): Scenario[] => [
  { name: `${name} (json)`, steps: [[...args, "--json"]] },
  { name: `${name} (human)`, steps: [[...args, "--human"]] },
];

export const SCENARIOS: Scenario[] = [
  ...both("whoami", ["whoami"]),
  ...both("context", ["context"]),
  ...both("workspace list", ["workspace", "list"]),
  { name: "workspace rename", steps: [["workspace", "rename", WS, "Renamed", "--json"], ["workspace", "ls", "--human"]] },

  ...both("project list", ["project", "list"]),
  ...both("project list archived", ["project", "ls", "--archived"]),
  ...both("project get", ["project", "get", P1]),
  ...both("project get from env", ["project", "get"]),
  { name: "project create", steps: [["project", "create", "Gamma", "--slug", "GAM", "-d", "third", "--json"], ["project", "ls", "--human"]] },
  { name: "project update", steps: [["project", "update", P1, "--name", "Alpha 2", "--slug", "AL2", "--json"], ["project", "get", P1, "--human"]] },
  { name: "project update clears description", steps: [["project", "update", P1, "-d", "", "--json"]] },
  { name: "project archive and unarchive", steps: [["project", "archive", P2, "--json"], ["project", "ls", "--human"], ["project", "unarchive", P2, "--human"], ["project", "ls", "--json"]] },

  ...both("task list", ["task", "list"]),
  ...both("task list all", ["task", "ls", "--all"]),
  ...both("task list by status", ["task", "ls", "--status", "in-progress"]),
  ...both("task list by priority", ["task", "ls", "--priority", "high"]),
  ...both("task get by number", ["task", "get", "1"]),
  ...both("task get by id", ["task", "get", "task-a2"]),
  ...both("task get unknown", ["task", "get", "99"]),
  { name: "task create", steps: [["task", "create", "New one", "-d", "body", "--priority", "low", "--json"], ["task", "ls", "--human"]] },
  { name: "task create assigned", steps: [["task", "create", "Mine", "--assignee", "user-1", "--status", "in-progress", "--human"], ["task", "get", "4", "--json"]] },
  { name: "task create bad priority", steps: [["task", "create", "x", "--priority", "huge", "--json"]] },
  { name: "task status", steps: [["task", "status", "1", "done", "--json"], ["task", "get", "1", "--human"]] },
  { name: "task priority", steps: [["task", "priority", "1", "urgent", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task assign and clear", steps: [["task", "assign", "1", "user-1", "--json"], ["task", "assign", "1", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task move", steps: [["task", "move", "1", "--to", P2, "--json"], ["task", "ls", "-p", P2, "--human"]] },
  { name: "task move without --to", steps: [["task", "move", "1", "--json"]] },
  { name: "task rm needs --yes", steps: [["task", "rm", "1", "--human"], ["task", "rm", "1", "--yes", "--json"], ["task", "ls", "--all", "--json"]] },
  { name: "task link and links", steps: [["task", "link", "1", "2", "--json"], ["task", "link", "1", "3", "--type", "blocks", "--human"], ["task", "links", "1", "--json"], ["task", "links", "1", "--human"]] },

  ...both("comment list", ["comment", "list", "1"]),
  { name: "comment add", steps: [["comment", "add", "1", "hello", "world", "--json"], ["comment", "ls", "1", "--human"]] },

  {
    name: "session attach, next, close",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [["session", "attach", "1", "write", "tests", "--strict"], ["session", "next", "ship", "--strict"], ["board", "--json"], ["board", "--human"], ["session", "close", "--strict"], ["board", "--json"]],
  },
  { name: "session attach fails quietly", env: { KANEO_SESSION_ID: "sess-test" }, steps: [["session", "attach", "99"]] },
  { name: "session attach strict reports", env: { KANEO_SESSION_ID: "sess-test" }, steps: [["session", "attach", "99", "--strict"]] },
  ...both("board", ["board"]),
  ...both("board archived", ["board", "--archived"]),
  { name: "board pages past one page", pageSize: 2, steps: [["task", "ls", "--all", "--json"], ["board", "--json"]] },

  ...both("api-check", ["api-check"]),

  { name: "no api key", env: { KANEO_API_KEY: "" }, steps: [["whoami"], ["task", "ls"]] },
  { name: "wrong api key", env: { KANEO_API_KEY: "nope" }, steps: [["whoami", "--json"], ["task", "ls", "--json"]] },
  { name: "no workspace", env: { KANEO_WORKSPACE: "" }, steps: [["project", "ls", "--json"]] },
  { name: "no project", env: { KANEO_PROJECT: "" }, steps: [["task", "ls", "--json"]] },
  { name: "unknown command", steps: [["frobnicate"]] },
  // An unreleased build reports itself as dev; scripts/build.ts stamps the tag.
  { name: "version", steps: [["--version"], ["-v"]] },

  {
    name: "profile supplies workspace and project",
    env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "" },
    config: { default_profile: "self", profiles: { self: { workspace_id: WS, project_id: P2 } } },
    steps: [["context", "--json"], ["task", "ls", "--json"]],
  },
  {
    name: ".kaneo.json found by walking up",
    env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "" },
    local: { workspace: WS, project: P2 },
    steps: [["context", "--json"], ["task", "ls", "--human"]],
  },
  {
    name: "repo map and owner map",
    env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "" },
    repo: "acme/widget",
    config: { repos: { "acme/widget": [P1, P2] }, owners: { acme: WS } },
    steps: [["context", "--json"], ["board", "--json"]],
  },
  {
    name: "flag beats env beats profile",
    config: { default_profile: "self", profiles: { self: { workspace_id: "ws-other", project_id: P2 } } },
    steps: [["context", "--json"], ["context", "-p", "proj-old", "--json"]],
  },
  {
    name: "hooks run after attach and close",
    env: { KANEO_SESSION_ID: "sess-hook" },
    config: {
      hooks: {
        attach: 'printf "%s %s %s %s\\n" "$KANEO_HOOK_EVENT" "$KANEO_TASK_ID" "$KANEO_TASK_NUMBER" "$KANEO_TASK_REF" >> "$HOME/.config/kaneo/hook.out"',
        close: 'printf "%s %s\\n" "$KANEO_HOOK_EVENT" "$KANEO_TASK_ID" >> "$HOME/.config/kaneo/hook.out"',
      },
    },
    steps: [["session", "attach", "2", "--strict"], ["session", "close", "--strict"]],
  },
  {
    name: "a failing hook does not fail the attach",
    env: { KANEO_SESSION_ID: "sess-hook" },
    config: { hooks: { attach: 'echo "hook says no" >&2; exit 3' } },
    steps: [["session", "attach", "1", "--strict"]],
  },
];
