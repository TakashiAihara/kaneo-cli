import type { Seed } from "./fake";

// The CLI's observable behaviour, as command sequences run against
// tests/parity/fake.ts. The goldens in tests/parity/golden/ were recorded from
// the Go build when it was retired and are recorded again from this tree by
// scripts/record-golden.ts when a change means to alter them;
// tests/parity/parity.test.ts runs these through this build and compares. Each
// scenario starts from a fresh fake seeded with SEED, a fresh HOME, and a cwd
// outside any repository.

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
  comments: [{ taskId: "task-a1", content: "first comment" }, { taskId: "task-a3", content: "not mine", id: "cmt-other", userId: "user-1" }],
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
  // Writes this text as config.json, for a file that is not valid JSON.
  rawConfig?: string;
  // The fake answers like a server older than the pinned document.
  legacy?: boolean;
  // The fake holds every response back this long.
  delayMs?: number;
  // The fake answers matching "METHOD path" requests with whitespace only.
  whitespaceOn?: string;
  pageSize?: number;
  // A seed layered over SEED for this scenario alone, so one that needs a project
  // in the second workspace does not put it in every other scenario's goldens.
  seed?: Partial<Seed>;
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
  { name: "project create derives the slug", steps: [["project", "create", "Gamma Ray!", "--human"]] },
  { name: "project create keeps the description", steps: [["project", "create", "Delta", "--slug", "DEL", "-d", "fourth", "--json"], ["project", "get", "proj0002", "--human"]] },
  {
    // The project is made before the description fails, so the error has to
    // name it and say how to finish.
    name: "project create whose description cannot be set",
    whitespaceOn: "^GET /project/",
    steps: [["project", "create", "Epsilon", "-d", "fifth", "--json"]],
  },
  { name: "project create with a derived slug already taken", steps: [["project", "create", "Alphabet", "--json"], ["project", "create", "Old Lake Docs", "--json"], ["project", "create", "Alphabet", "--slug", "ALP2", "--json"]] },

  { name: "project create with an underivable slug", steps: [["project", "create", "!!!", "--json"]] },
  { name: "project update", steps: [["project", "update", P1, "--name", "Alpha 2", "--slug", "AL2", "--json"], ["project", "get", P1, "--human"]] },
  { name: "project update clears description", steps: [["project", "update", P1, "-d", "", "--json"]] },
  {
    // The server takes an empty slug, and refusing to write such a project left
    // no way to rename it.
    name: "project update with an empty slug",
    seed: { projects: [...SEED.projects, { id: "proj-noslug", workspaceId: WS, name: "No slug", slug: "" }] },
    steps: [["project", "update", "proj-noslug", "--name", "Has a name now", "--json"]],
  },
  { name: "project archive and unarchive", steps: [["project", "archive", P2, "--json"], ["project", "ls", "--human"], ["project", "unarchive", P2, "--human"], ["project", "ls", "--json"]] },

  ...both("column list", ["column", "list"]),
  { name: "column create and reorder", steps: [["column", "create", "Waiting", "--json"], ["column", "reorder", "to-do", "waiting", "in-progress", "done", "--human"], ["column", "ls", "--json"], ["task", "status", "1", "waiting", "--json"], ["board", "--human"]] },
  { name: "column reorder must name every column", steps: [["column", "reorder", "done", "to-do", "--json"], ["column", "reorder", "to-do", "to-do", "in-progress", "done", "--json"], ["column", "reorder", "to-do", "nope", "in-progress", "done", "--json"]] },
  { name: "column rename", steps: [["column", "rename", "in-progress", "Doing", "--json"], ["column", "ls", "--human"]] },
  { name: "column rm needs --yes", steps: [["column", "rm", "done", "--human"], ["column", "rm", "done", "--yes", "--json"], ["column", "create", "Waiting", "--json"], ["column", "rm", "waiting", "--yes", "--json"], ["column", "ls", "--json"]] },
  { name: "column unknown", steps: [["column", "rename", "nope", "x", "--json"]] },
  { name: "column by id and name", steps: [["column", "rename", "col0002", "Doing", "--json"], ["column", "reorder", "col0001", "done", "Doing", "--human"]] },
  { name: "column create with flags", steps: [["column", "create", "外部回答", "待ち", "--final", "--icon", "Clock", "--color", "#f00", "--json"], ["column", "rename", "外部回答-待ち", "Waiting", "on", "review", "--json"], ["column", "ls", "--human"]] },
  { name: "column names refused", steps: [["column", "create", "Planned", "--json"], ["column", "create", "!!!", "--json"], ["column", "create", "To Do", "--json"], ["column", "create", " ", "--json"], ["column", "rename", "to-do", " ", "--json"], ["column", "rename", "in-progress", "To Do", "--json"], ["column", "rename", "To Do", "x", "--json"]] },

  ...both("task list", ["task", "list"]),
  ...both("task list all", ["task", "ls", "--all"]),
  ...both("task list by status", ["task", "ls", "--status", "in-progress"]),
  ...both("task list by priority", ["task", "ls", "--priority", "high"]),
  ...both("task get by number", ["task", "get", "1"]),
  ...both("task get by id", ["task", "get", "task-a2"]),
  ...both("task get unknown", ["task", "get", "99"]),
  { name: "task get with no relations", steps: [["task", "get", "2", "--json"]] },
  { name: "task create", steps: [["task", "create", "New one", "-d", "body", "--priority", "low", "--json"], ["task", "ls", "--human"]] },
  { name: "task create assigned", steps: [["task", "create", "Mine", "--assignee", "user-1", "--status", "in-progress", "--human"], ["task", "get", "4", "--json"]] },
  { name: "task create bad priority", steps: [["task", "create", "x", "--priority", "huge", "--json"]] },
  { name: "task status", steps: [["task", "status", "1", "done", "--json"], ["task", "get", "1", "--human"]] },
  { name: "task priority", steps: [["task", "priority", "1", "urgent", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task assign and clear", steps: [["task", "assign", "1", "user-1", "--json"], ["task", "assign", "1", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task move", steps: [["task", "move", "1", "--to", P2, "--json"], ["task", "ls", "-p", P2, "--human"]] },
  { name: "task move without --to", steps: [["task", "move", "1", "--json"]] },
  { name: "task rm needs --yes", steps: [["task", "rm", "1", "--human"], ["task", "rm", "1", "--yes", "--json"], ["task", "ls", "--all", "--json"]] },
  { name: "task link and links", steps: [["task", "link", "1", "2", "--type", "subtask", "--json"], ["task", "links", "2", "--human"], ["task", "link", "1", "3", "--type", "blocks", "--human"], ["task", "links", "1", "--json"], ["task", "links", "1", "--human"], ["task", "get", "1", "--human"], ["task", "get", "1", "--json"], ["task", "links", "3", "--human"], ["task", "link", "2", "3", "--type", "subtask", "--human"]] },
  { name: "task link unknown type", steps: [["task", "link", "1", "2", "--type", "blocker", "--json"], ["task", "unlink", "1", "2", "--type", "blocker", "--json"]] },
  { name: "task link without --type", steps: [["task", "link", "1", "2", "--json"], ["task", "links", "1", "--json"]] },
  { name: "task unlink by tasks", steps: [["task", "link", "1", "2", "--type", "related", "--json"], ["task", "unlink", "2", "1", "--human"], ["task", "links", "1", "--json"], ["task", "link", "1", "2", "--type", "blocks", "--json"], ["task", "unlink", "2", "1", "--json"]] },
  { name: "task unlink by relation id", steps: [["task", "link", "1", "2", "--type", "blocks", "--json"], ["task", "unlink", "rel0002", "--type", "blocks", "--json"], ["task", "unlink", "rel0002", "--human"], ["task", "links", "1", "--json"]] },
  { name: "task unlink one task number", steps: [["task", "unlink", "1", "--json"], ["task", "unlink", "#1", "--json"]] },
  { name: "task unlink ambiguous", steps: [["task", "link", "1", "2", "--type", "related", "--json"], ["task", "link", "1", "2", "--type", "blocks", "--json"], ["task", "unlink", "1", "2", "--json"], ["task", "unlink", "1", "2", "--type", "blocks", "--human"], ["task", "links", "1", "--human"]] },
  { name: "task unlink nothing to unlink", steps: [["task", "unlink", "1", "2", "--json"]] },

  // --jq, the one flag every command carries: what a caller pipes a field into
  // python3 instead, and what must not cost a jq the reader has to install.
  {
    name: "jq picks a field",
    steps: [
      ["task", "create", "Piped", "--jq", ".number"],
      ["task", "get", "1", "--jq", ".status", "--human"],
      ["task", "get", "1", "--jq", "empty"],
    ],
  },
  { name: "jq over a list", steps: [["task", "ls", "--all", "--jq", ".[] | \"\\(.number) \\(.title)\""]] },
  // Nothing is asked of the server: the expression cannot compile, which is known
  // before the command would have asked anything.
  { name: "jq with a bad expression", steps: [["task", "ls", "--jq", ".[", "--json"]] },
  { name: "jq runtime error", steps: [["task", "get", "1", "--jq", ".title | tonumber"]] },
  { name: "jq leaves stdout empty on a command error", steps: [["task", "get", "99", "--jq", ".number"]] },
  // Refused while parsing, before the filter exists, and still kept off stdout.
  { name: "jq leaves stdout empty on a usage error", steps: [["task", "get", "--jq", ".number"], ["task", "get", "1", "--bogus", "--jq=.number"]] },
  { name: "jq keeps empty strings", steps: [["task", "ls", "--all", "--jq", ".[] | .description"]] },
  // Fail-open hides an unreachable server, not a broken expression.
  { name: "jq fails a fail-open command", env: { KANEO_SESSION_ID: "sess-test" }, steps: [["session", "attach", "1", "--jq", ".nope | tonumber"]] },
  { name: "jq empty means no filter", steps: [["task", "get", "1", "--jq", "", "--json"]] },

  ...both("comment list", ["comment", "list", "1"]),
  { name: "comment add", steps: [["comment", "add", "1", "hello", "world", "--json"], ["comment", "ls", "1", "--human"]] },
  {
    name: "comment delete",
    steps: [
      ["comment", "delete", "2", "cmt0001", "--human"],
      ["comment", "rm", "1", "nope", "--json"],
      ["comment", "add", "1", "second", "--human"],
      ["comment", "add", "1", "third", "--human"],
      ["comment", "delete", "1", "cmt000", "--human"],
      ["comment", "delete", "1", "cmt0002", "--human"],
      ["comment", "rm", "1", "cmt0002", "--json"],
      ["comment", "delete", "1", "cmt0003", "--json"],
      ["comment", "delete", "3", "cmt-other", "--human"],
      ["comment", "ls", "1", "--json"],
    ],
  },
  { name: "comment edit", steps: [["comment", "edit", "2", "cmt0001", "x"], ["comment", "edit", "1", "nope", "x"], ["comment", "edit", "1", "cmt0001", ""], ["comment", "edit", "3", "cmt-other", "x"], ["comment", "edit", "1", "cmt0001", "rewritten", "text", "--json"], ["comment", "ls", "1", "--human"]] },

  ...both("activity list", ["activity", "list", "1"]),
  {
    name: "activity add",
    steps: [
      ["activity", "add", "1", "status_changed", "--data", '{"oldStatus":"to-do","newStatus":"done"}', "--json"],
      ["activity", "add", "1", "imported", "from\ntrello", "--data", '{"source":"trello"}', "--human"],
      ["activity", "add", "1", "comment", "hi"],
      ["activity", "add", "1", "created", "--data", "{}"],
      ["activity", "add", "1", "x", "--data", "[1]"],
      ["activity", "add", "1", "x", "--data", "nope"],
      ["activity", "ls", "1", "--human"],
      ["activity", "ls", "1", "--json"],
    ],
  },

  {
    name: "label create, attach, detach",
    steps: [
      ["label", "create", "bug", "--color", "red", "--json"],
      ["label", "create", "needs", "review", "--human"],
      ["label", "create", "bug", "--color", "green", "--json"],
      ["label", "create", "bug", "--color", "green", "--human"],
      ["label", "ls", "--human"],
      ["label", "attach", "1", "bug", "--human"],
      ["label", "attach", "2", "needs review", "--json"],
      ["label", "attach", "1", "nope", "--human"],
      ["label", "ls", "1", "--json"],
      ["task", "ls", "--json"],
      ["label", "detach", "1", "bug", "--human"],
      ["label", "detach", "1", "bug", "--json"],
      ["label", "ls", "1", "--human"],
      ["label", "ls", "--json"],
    ],
  },
  {
    name: "label update and rm",
    steps: [
      ["label", "create", "bug", "--json"],
      ["label", "attach", "1", "bug", "--human"],
      ["label", "attach", "2", "bug", "--human"],
      ["label", "update", "bug", "--name", "defect", "--color", "red", "--json"],
      ["label", "update", "defect", "--human"],
      ["label", "ls", "2", "--human"],
      ["label", "rm", "defect", "--human"],
      ["label", "rm", "defect", "--yes", "--json"],
      ["label", "ls", "--json"],
      ["label", "ls", "1", "--json"],
      ["label", "ls", "2", "--json"],
    ],
  },
  {
    name: "label get",
    steps: [["label", "create", "bug", "--json"], ["label", "attach", "1", "bug", "--json"], ["label", "get", "bug", "--human"], ["label", "get", "lbl0003", "--json"], ["label", "get", "nope", "--json"]],
  },
  { name: "label without a workspace", env: { KANEO_WORKSPACE: "" }, steps: [["label", "ls", "--json"], ["label", "create", "bug", "--human"]] },
  {
    name: "label ids and names",
    steps: [
      ["label", "create", "x", "--human"],
      ["label", "create", "x", "--human"],
      ["label", "create", "lbl0002", "--human"],
      ["label", "get", "lbl0002", "--human"],
      ["label", "attach", "1", "lbl0002", "--human"],
      ["label", "detach", "1", "lbl0002", "--human"],
      ["label", "update", "x", "--name", "lbl0002", "--human"],
      ["label", "update", "x", "--name", " lbl0002 ", "--human"],
      ["label", "update", "x", "--name", "x", "--color", "red", "--human"],
      ["label", "create", "y", "--color", "", "--human"],
      ["label", "attach", "1", "x", "--human"],
      ["label", "attach", "1", "lbl0003", "--human"],
      ["label", "detach", "1", "lbl0002", "--human"],
      ["label", "ls", "1", "--human"],
      ["label", "ls", "--human"],
    ],
  },

  {
    name: "session attach, next, close",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [["session", "attach", "1", "write", "tests", "--strict"], ["session", "next", "ship", "--strict"], ["board", "--json"], ["board", "--human"], ["session", "close", "--strict"], ["board", "--json"]],
  },
  { name: "session attach fails quietly", env: { KANEO_SESSION_ID: "sess-test" }, steps: [["session", "attach", "99"]] },
  { name: "session attach strict reports", env: { KANEO_SESSION_ID: "sess-test" }, steps: [["session", "attach", "99", "--strict"]] },
  // Reads only what is on this machine, so it answers before anything is
  // attached and makes no request.
  {
    name: "session status before attaching",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [["session", "status", "--json"], ["session", "status", "--human"]],
  },
  {
    name: "session history survives close",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [["session", "attach", "1", "--strict"], ["session", "close", "--strict"], ["session", "status", "--json"]],
  },
  // A session may hold several tasks, and closing one of them must leave the
  // attachment on the other alone.
  {
    name: "session close names a task",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [
      ["session", "attach", "1", "--strict"],
      ["session", "attach", "2", "--strict"],
      ["session", "close", "--task", "1", "--strict"],
      ["session", "status", "--json"],
      ["session", "status", "--human"],
      ["session", "close", "--strict"],
      ["session", "status", "--human"],
    ],
  },
  // Naming the attached task closes it as a plain close would, board included.
  {
    name: "session close names the attached task",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [["session", "attach", "1", "--strict"], ["session", "close", "--task", "1", "--strict"], ["session", "status", "--json"]],
  },
  {
    name: "session close --task without an attachment",
    env: { KANEO_SESSION_ID: "sess-test" },
    // Named the way `session status` prints it, so a reference read off the
    // history can be handed straight back.
    steps: [["session", "close", "--task", "ALP#2", "--strict", "--json"]],
  },
  {
    name: "session status without a session id",
    env: { KANEO_SESSION_ID: "" },
    steps: [["session", "status", "--json"]],
  },
  ...both("board", ["board"]),
  ...both("board archived", ["board", "--archived"]),
  { name: "board pages past one page", pageSize: 2, steps: [["task", "ls", "--all", "--json"], ["board", "--json"]] },

  ...both("api-check", ["api-check"]),

  { name: "no api key", env: { KANEO_API_KEY: "" }, steps: [["whoami"], ["task", "ls"]] },
  { name: "wrong api key", env: { KANEO_API_KEY: "nope" }, steps: [["whoami", "--json"], ["task", "ls", "--json"]] },
  { name: "no workspace", env: { KANEO_WORKSPACE: "" }, steps: [["project", "ls", "--json"]] },
  { name: "no project", env: { KANEO_PROJECT: "" }, steps: [["task", "ls", "--json"]] },
  { name: "unknown command", steps: [["frobnicate"]] },
  { name: "unknown subcommand", steps: [["task", "frob"], ["comment", "nope", "--json"], ["session", "x"], ["task"]] },
  ...[["--help"], ["help"], ["help", "project"], ["task", "--help"], ["task", "create", "--help"], ["project", "get", "--help"], ["session"], ["session", "next", "--help"]].map(
    (args, i): Scenario => ({ name: `help ${i + 1}: ${args.join(" ")}`, steps: [args] }),
  ),
  { name: "unknown flag", steps: [["task", "ls", "--bogus"], ["task", "ls", "-x"], ["--bogus"]] },
  { name: "control characters in an unknown command", steps: [["\u0001"], ["a\u007fb"], ["tab\there"]] },
  { name: "completion help", steps: [["completion", "zsh", "--help"], ["completion", "fish", "--help"], ["completion", "powershell", "--help"], ["completion", "bash", "--help"]] },
  { name: "completion", steps: [["completion", "zsh"], ["completion", "bash"], ["completion", "fish"], ["completion", "powershell"], ["completion"]] },
  // What a shell asks once the script is installed: cobra's answer carries a
  // directive line and reports it on stderr, and the NoDesc spelling leaves the
  // descriptions out.
  ...[
    ["__complete", ""],
    ["__completeNoDesc", ""],
    ["__complete", "ta"],
    ["__complete", "task", ""],
    ["__completeNoDesc", "task", ""],
    ["__complete", "task", "create", "--"],
    ["__complete", "--wo"],
    ["__complete", "completion", ""],
    ["__complete", "help", ""],
    ["__complete", "frobnicate", ""],
    ["__complete", "task", "status", ""],
    ["__complete", "task", "ls", "--status", ""],
    ["__complete", "--timeout", ""],
    ["__complete", "-w", ""],
    ["__complete", "--version"],
    ["__complete", "task", "create", "--priority", ""],
    ["__complete", "session", "attach", ""],
  ].map((args, i): Scenario => ({ name: `shell asks ${i + 1}: ${args.join(" ")}`, steps: [args] })),

  { name: "server unreachable", env: { KANEO_API_URL: "http://127.0.0.1:9" }, steps: [["whoami", "--json"], ["task", "ls"], ["board"]] },
  { name: "request timeout", delayMs: 1500, steps: [["whoami", "--json", "--timeout", "300ms"], ["task", "ls", "--timeout", "300ms"]] },
  { name: "timeout zero or negative", steps: [["whoami", "--json", "--timeout", "0"], ["whoami", "--json", "--timeout", "-1s"], ["whoami", "--timeout", "nonsense"]] },

  { name: "config that is not JSON", env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "" }, rawConfig: "{not json", steps: [["context", "--json"], ["task", "ls"]] },
  { name: "config with a null profile", rawConfig: '{"profiles":{"dev":null},"default_profile":"dev"}', steps: [["context", "--json"]] },
  { name: "config that is null", rawConfig: "null", steps: [["context", "--json"]] },
  { name: "config with a malformed number", rawConfig: '{"unknown":1.}', steps: [["context", "--json"]] },
  {
    name: "config with a wrong type",
    env: { KANEO_SESSION_ID: "sess-types" },
    config: { hooks: { attach: 5 } },
    steps: [["session", "attach", "1", "--strict"], ["context", "--json"]],
  },
  {
    name: "config keys in another case",
    env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "" },
    config: { Default_Profile: "self", Profiles: { self: { Workspace_ID: WS, project_id: P2 } } },
    steps: [["context", "--json"]],
  },

  { name: "ids that need escaping", steps: [["task", "get", "a b/c?#%é", "--json"], ["comment", "ls", "x/y", "--json"], ["project", "get", "p/q", "--json"]] },

  ...[["project", "ls", "--json"], ["project", "get", "--json"], ["task", "ls", "--json"], ["task", "ls", "--human"], ["board", "--json"], ["board", "--human"], ["comment", "ls", "1", "--json"], ["comment", "ls", "1", "--human"], ["task", "links", "1", "--json"]].map(
    (args): Scenario => ({ name: `older server: ${args.join(" ")}`, legacy: true, steps: [args] }),
  ),
  { name: "older server: task get", legacy: true, steps: [["task", "link", "1", "2", "--type", "blocks", "--json"], ["task", "get", "1", "--human"], ["task", "get", "1", "--json"]] },
  { name: "older server: task links human", legacy: true, steps: [["task", "link", "1", "2", "--type", "blocks", "--json"], ["task", "links", "1", "--human"]] },

  { name: "no git on PATH", env: { PATH: "/nonexistent" }, steps: [["task", "ls", "--json"], ["context", "--json"]] },
  { name: "no git on PATH, session", env: { PATH: "/nonexistent", KANEO_SESSION_ID: "sess-nogit" }, steps: [["session", "attach", "1", "--strict"], ["session", "close", "--strict"]] },

  {
    name: "a failing hook's output keeps both streams",
    env: { KANEO_SESSION_ID: "sess-streams" },
    config: { hooks: { attach: "echo out; echo err >&2; echo out2; exit 4" } },
    steps: [["session", "attach", "1", "--strict"]],
  },
  {
    name: "a hook killed by a signal",
    env: { KANEO_SESSION_ID: "sess-signal" },
    config: { hooks: { attach: "kill -USR1 $$", close: "kill -SEGV $$" } },
    steps: [["session", "attach", "1", "--strict"], ["session", "close", "--strict"]],
  },
  // Each request alone fits in the timeout; the command's requests together do
  // not. One deadline for the whole command fails; one per request would pass.
  { name: "one deadline per command", delayMs: 400, env: { KANEO_SESSION_ID: "sess-budget" }, steps: [["session", "attach", "1", "--strict", "--timeout", "1s"], ["board", "--json", "--timeout", "1s"]] },
  { name: "whitespace reply to the marker post", whitespaceOn: "^POST /comment/", env: { KANEO_SESSION_ID: "sess-ws" }, config: { hooks: { attach: 'echo ran > "$HOME/hook-ran"' } }, steps: [["session", "attach", "1", "--strict"], ["session", "next", "x", "--strict"]] },
  { name: "whitespace reply to project get", whitespaceOn: "^GET /project/", steps: [["project", "get", "--json"]] },
  { name: "whitespace reply to task create", whitespaceOn: "^POST /task/", steps: [["task", "create", "x", "--json"]] },
  { name: "whitespace reply to the project list", whitespaceOn: "^GET /project$", steps: [["project", "ls", "--json"], ["board", "--json"]] },
  {
    name: "hook failure logged in local time",
    env: { KANEO_SESSION_ID: "sess-tz", TZ: "Asia/Tokyo" },
    config: { hooks: { attach: "exit 2" } },
    steps: [["session", "attach", "1", "--strict"]],
  },

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
    name: "context for another repo",
    env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "" },
    local: { project: "proj-local" },
    repo: "acme/other",
    config: { owners: { acme: "ws-acme" }, repos: { "acme/thing": ["proj-x", "proj-y"], "acme/other": ["proj-other"] } },
    steps: [
      ["context", "--repo", "acme/thing", "--json"],
      ["context", "--repo", "git@github.com:acme/thing.git", "--human"],
      ["context", "--repo", "nobody/else", "--json"],
      ["context", "--repo", "acme/thing.git", "--json"],
      ["context", "--repo", "acme/thing", "-p", "proj-flag", "--json"],
      ["context", "--json"],
    ],
  },
  {
    name: "context --repo under a profile with a project",
    config: { owners: { acme: "ws-acme" }, repos: { "acme/thing": ["proj-x"] }, profiles: { main: { project_id: "proj-profile" } } },
    env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "" },
    steps: [["context", "--repo", "acme/thing", "--json"]],
  },
  {
    name: "context --repo under KANEO_PROJECT",
    config: { owners: { acme: "ws-acme" }, repos: { "acme/thing": ["proj-x"] } },
    env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "proj-env" },
    steps: [
      ["context", "--repo", "acme/thing", "--json"],
      ["context", "--repo", " acme/thing/ ", "--json"],
    ],
  },
  {
    name: "context --repo that is not a repo",
    steps: [
      ["context", "--repo", "just-a-name", "--json"],
      ["context", "--repo", "a/b/c", "--json"],
      ["context", "--repo", "", "--json"],
      ["context", "--repo", "../x", "--json"],
      ["context", "--repo", "a@b/c", "--json"],
      ["context", "--repo", "github.com:acme/thing", "--json"],
    ],
  },
  {
    name: "--api-url and --api-key beat the environment",
    env: { KANEO_API_URL: "http://127.0.0.1:9", KANEO_API_KEY: "wrong-key" },
    steps: [["whoami", "--json", "--api-url", "<URL>", "--api-key", "test-key"], ["context", "--json", "--api-url", "<URL>"]],
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

  // The settings take a project's id, a slug or a name, and a value the server
  // does not know is looked up across the workspaces the key can reach.
  { name: "project by slug", steps: [["task", "ls", "-p", "BET", "--json"], ["task", "create", "x", "-p", "bet", "--human"], ["project", "get", "ALP", "--human"], ["board", "-p", "BET", "--json"]] },
  { name: "project by name", steps: [["task", "ls", "-p", "Beta", "--human"]] },
  { name: "project not found", steps: [["task", "ls", "-p", "nope", "--json"]] },
  { name: "task reference with a slug", steps: [["task", "get", "BET#1", "--json"], ["comment", "add", "ALP#2", "hi", "--human"]] },
  {
    // A workspace whose name is not its slug, with a project in it, so the
    // output itself shows which workspace a name or a slug reached.
    name: "workspace by slug and name",
    seed: {
      workspaces: [...SEED.workspaces, { id: "ws-third", name: "Third Space", slug: "third" }],
      projects: [...SEED.projects, { id: "proj-delta", workspaceId: "ws-third", name: "Delta", slug: "DEL" }],
    },
    steps: [
      ["project", "ls", "-w", "third", "--json"],
      ["project", "ls", "-w", "third space", "--human"],
      ["project", "ls", "-w", "ws-third", "--human"],
    ],
  },
  { name: "workspace not found", steps: [["project", "ls", "-w", "nope", "--json"]] },
  { name: "task lookup error names the project", steps: [["task", "get", "99", "--json"], ["task", "get", "#99", "--human"], ["task", "get", "BET#99", "--human"]] },
  {
    // Slugs are not unique on the server, so one that two projects carry names
    // both rather than picking one; an exact-case match still wins over a folded one.
    name: "a slug two projects carry",
    seed: {
      projects: [
        ...SEED.projects,
        { id: "proj-bet2", workspaceId: "ws-other", name: "Bet Two", slug: "BET" },
        { id: "proj-lower", workspaceId: "ws-other", name: "Lower", slug: "alp" },
      ],
    },
    steps: [["task", "ls", "-p", "BET", "--json"], ["project", "get", "alp", "--human"]],
  },
  {
    // An archived project is still found by its slug, which is how one gets
    // unarchived, and the report carries the id the slug resolved to.
    name: "project by slug in a write",
    steps: [["project", "unarchive", "OLD", "--json"], ["task", "move", "1", "--to", "Beta", "--json"]],
  },
  {
    // The same failure with the project named by a .kaneo.json rather than the
    // environment, so the origin the message reports is the other layer's.
    name: "task lookup error names the project from a local config",
    env: { KANEO_PROJECT: "" },
    local: { project: P2 },
    steps: [["task", "get", "99", "--human"]],
  },
  {
    // One project in the second workspace, so a listing across workspaces has
    // something there to show and `find` has somewhere else to look.
    name: "project list across workspaces",
    seed: { projects: [...SEED.projects, { id: "proj-gamma", workspaceId: "ws-other", name: "Gamma", slug: "GAM" }] },
    steps: [["project", "ls", "-A", "--json"], ["project", "ls", "--all-workspaces", "--archived", "--human"]],
  },
  {
    // A second match in the second workspace, so the search reaching outside the
    // workspace the settings name is what the output shows.
    name: "project find",
    seed: { projects: [...SEED.projects, { id: "proj-beacon", workspaceId: "ws-other", name: "Beacon", slug: "BCN" }] },
    steps: [["project", "find", "be", "--json"], ["project", "find", "OLD", "--human"], ["project", "find", "zzz", "--json"]],
  },
];
