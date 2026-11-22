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
const P2 = "proj-beta";

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
  notifications: [
    { type: "info", title: "Welcome", content: "hello there", isRead: true },
    { type: "task_status_changed", eventData: { taskTitle: "Write the parser", oldStatus: "to-do", newStatus: "in-progress" } },
    { type: "info", content: "read state never set", isRead: null },
  ],
};

// The seeded notifications' ids, in the fake's own sequence for them.
const N1 = "ntf0001";
const N2 = "ntf0002";
const N3 = "ntf0003";

// The token the fake mints the n-th calendar feed with: "feed" is hex, so
// repeating it pads the sequence to the token's 64 hex characters.
const feedToken = (n: number) => `${"feed".repeat(15)}${n.toString(16).padStart(4, "0")}`;

const MEMBERS: Seed["members"] = [
  { id: "user-self", name: "Self", email: "self@example.com", role: "owner" },
  { id: "user-1", name: "Ada", email: "ada@example.com", role: "reviewer" },
];

const INVITATIONS: Seed["invitations"] = [
  { id: "inv-open", workspaceId: "ws-other", inviterName: "Grace", expiresAt: "2026-01-01T13:00:00.000Z" },
  { id: "inv-expired", workspaceId: "ws-other", inviterName: "Grace", expiresAt: "2026-01-01T01:00:00.000Z" },
  { id: "inv-accepted", workspaceId: WS, inviterName: "Grace", expiresAt: "2026-01-01T13:00:00.000Z", status: "accepted" },
  { id: "inv-canceled", workspaceId: WS, inviterName: "Grace", expiresAt: "2026-01-01T13:00:00.000Z", status: "canceled" },
  // Expires at the very moment the fake judges at, which still counts as open.
  { id: "inv-boundary", workspaceId: WS, inviterName: "Grace", expiresAt: "2026-01-01T12:00:00.000Z" },
];

// A project's custom fields and the values its tasks hold for them, for the
// scenarios that exercise `field` and `task field`. The fake numbers them in
// its own sequence, so the fields are fld0001… and the values cfv0004… here.
const FIELD_SEED: Partial<Seed> = {
  customFields: [
    { projectId: P1, name: "Priority note", type: "text" },
    { projectId: P1, name: "Story points", type: "number" },
    { projectId: P1, name: "Release", type: "dropdown", options: ["Web", "CLI"] },
  ],
  customFieldValues: [
    { taskId: "task-a1", field: "Priority note", value: "needs review" },
    { taskId: "task-a1", field: "Story points", value: "3" },
    { taskId: "task-a2", field: "Release", value: "Web" },
    { taskId: "task-a3", field: "Release", value: "CLI" },
  ],
};

// A project's stored link to a GitLab project. The token is stored raw and
// only ever answered masked; the values are fixtures, never real credentials.
const GITLAB: NonNullable<Seed["gitlabIntegrations"]> = [
  {
    projectId: P1,
    baseUrl: "https://gitlab.example.com",
    projectPath: "acme/web-app",
    token: "seeded-token-0123456789abcdef",
    hookSecret: "whsec_seeded_cafebabe",
    isActive: true,
    commentLink: true,
    branchPattern: "{slug}-{number}",
  },
];

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
  // Tasks seeded alongside SEED, for a board the shared seed does not have.
  extraTasks?: Seed["tasks"];
  // The fake answers like a server older than the pinned document.
  legacy?: boolean;
  // The fake leaves these fields out of a project read.
  readWithout?: string[];
  // Sends these project fields with these values in a read (see the fake).
  readAs?: Record<string, unknown>;
  // The fake holds every response back this long.
  delayMs?: number;
  // The fake answers matching "METHOD path" requests with whitespace only.
  whitespaceOn?: string;
  // The fake answers matching "METHOD path" requests with a 500, having
  // changed nothing.
  failOn?: string;
  failOnQuery?: string;
  failStatus?: number;
  failMessage?: string;
  plainMember?: boolean;
  // The fake refuses a project move into this workspace with the bare 403 the
  // destination-side permission check gives, while the source check passes.
  moveDeniedTarget?: string;
  noCurrentUser?: boolean;
  blankCurrentUserId?: boolean;
  failOnSkip?: number;
  rateLimitTimes?: number;
  rateLimitWaitMs?: number;
  rateLimitCode?: string;
  // The fake answers a matching PUT with a 200 while storing an altered title or
  // description, so a read-back finds something the client did not send.
  misstoreOn?: string;
  // The fake answers a comment listing without the comments whose content
  // matches, so a marker the server accepted and did not keep can be exercised.
  dropCommentsMatching?: string;
  // The fake answers a status, priority, assignee or move write with the task
  // unchanged.
  writesNotKept?: boolean;
  // The fake answers a comment post without the comment's id.
  commentReplyWithoutId?: boolean;
  // The fake's import-issues answers carry these per-issue errors.
  gitlabImportErrors?: string[];
  // The fake's verify answer carries these fields instead of the canned success.
  gitlabVerify?: Record<string, unknown>;
  // The fake's OpenAPI document drifts from the pinned one in two request fields.
  driftedSpec?: boolean;
  // The fake's OpenAPI document lacks createTask, an operation the client calls.
  specWithoutOperation?: boolean;
  pageSize?: number;
  // A seed layered over SEED for this scenario alone, so one that needs a project
  // in the second workspace does not put it in every other scenario's goldens.
  seed?: Partial<Seed>;
  // The fake grows the project by a task when the listing is asked for this
  // page, so the board changes while it is read. growTimes caps how many
  // requests grow it; without a cap it never settles.
  growOnPage?: number;
  growTimes?: number;
  // The fake moves this task to the front of the listing when the listing is
  // asked for this page, so the board's order changes mid-read while its
  // total stays put.
  promoteOnPage?: number;
  promoteTaskId?: string;
  promoteTimes?: number;
  // The fake answers the listing without applying status or priority.
  ignoreFilters?: boolean;
  assignedLimit?: number;
  // Written to every step's stdin, for text a pipe carries.
  stdin?: string;
  // Written into the cwd before the first step, for the file a flag names —
  // bytes when the upload has to be something text cannot write, like a PNG.
  files?: Record<string, string | Uint8Array>;
  // Written under the scenario's HOME before the first step, parents created —
  // for what a command reads out of the config directory, like a session
  // store file written by hand.
  homeFiles?: Record<string, string | Uint8Array>;
  // Directories made under the scenario's HOME before the first step, for a
  // path that must be a directory rather than hold a file — like the history
  // path that makes an append fail.
  homeDirs?: string[];
};

const both = (name: string, args: string[]): Scenario[] => [
  { name: `${name} (json)`, steps: [[...args, "--json"]] },
  { name: `${name} (human)`, steps: [[...args, "--human"]] },
];

// The integrations' credential flags, named through constants so the
// credential-shaped literals stay out of this file's argv lists the way the
// CLI's own tests keep them out of a command line.
const WF = "--webhook" + "-url";
const SF = "--" + "secret";
const WF_FILE = WF + "-file";
const SF_FILE = SF + "-file";

// The --webhook-url flag, spelled in two halves on purpose: the whole
// literal in an argv list reads as a credential flag to the guards that
// screen command lines for secrets and mangle it, so the scenarios name it
// without ever writing it whole. The flag the steps pass is the same.
const WEBHOOK_URL_FLAG = "--webhook" + "-url";

export const SCENARIOS: Scenario[] = [
  ...both("whoami", ["whoami"]),
  ...both("context", ["context"]),
  ...both("workspace list", ["workspace", "list"]),
  // A server before v2.28.0 has no /user/me: the key was accepted, and whoami
  // says why it still cannot say whose it is.
  { name: "whoami on a server without user me", noCurrentUser: true, steps: [["whoami", "--human"]] },
  // The column first, then a description the create form kept in metadata,
  // sent as better-auth's JSON text or already an object.
  ...both("workspace list with descriptions", ["workspace", "list"]).map(
    (s): Scenario => ({
      ...s,
      seed: {
        workspaces: [
          { id: WS, name: "Main", slug: "main", description: "  Work for clients\r\n\tand more " },
          { id: "ws-other", name: "Other", slug: "other", description: null, metadata: '{"description":"Kept in metadata"}' },
          { id: "ws-obj", name: "Object", slug: "obj", description: null, metadata: { description: "Parsed already" } },
          { id: "ws-both", name: "Both", slug: "both", description: "Column wins", metadata: '{"description":"Metadata loses"}' },
          { id: "ws-plain", name: "Plain", slug: "plain", description: null, metadata: null },
          { id: "ws-bad", name: "Bad\tmeta", slug: "bad", description: null, metadata: "{bad" },
        ],
      },
    }),
  ),
  { name: "workspace rename", steps: [["workspace", "rename", WS, "Renamed", "--json"], ["workspace", "ls", "--human"]] },

  ...both("project list", ["project", "list"]),
  ...both("project list archived", ["project", "ls", "--archived"]),
  ...both("project get", ["project", "get", P1]),
  ...both("project get from env", ["project", "get"]),
  { name: "project create", steps: [["project", "create", "Gamma", "--slug", "GAM", "-d", "third", "--json"], ["project", "ls", "--human"]] },
  // --name gives the name as project update takes it; with words too, empty, or
  // with neither, the create is refused before anything is asked.
  { name: "project create with --name", steps: [["project", "create", "--name", "Flagged", "--slug", "FLG", "--json"], ["project", "ls", "--human"]] },
  { name: "project create with --name and words", steps: [["project", "create", "Words", "--name", "Flagged", "--json"], ["project", "ls", "--human"]] },
  { name: "project create with no name", steps: [["project", "create", "--json"]] },
  { name: "project create with an empty --name", steps: [["project", "create", "--name", " ", "--json"], ["project", "create", "--name", "", "--json"], ["project", "create", "Words", "--name", "", "--json"], ["project", "ls", "--human"]] },
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

  {
    name: "project create with a derived slug taken in another case",
    seed: { projects: [...SEED.projects, { id: "proj-lower", workspaceId: WS, name: "Lower", slug: "low" }] },
    steps: [["project", "create", "Lowerworld", "--json"]],
  },
  {
    name: "project create with a derived slug taken in full-width letters",
    seed: { projects: [...SEED.projects, { id: "proj-wide", workspaceId: WS, name: "Wide", slug: "ＷＩＤ" }] },
    steps: [["project", "create", "Wideworld", "--json"]],
  },
  { name: "project create with an underivable slug", steps: [["project", "create", "!!!", "--json"]] },
  { name: "project update", steps: [["project", "update", P1, "--name", "Alpha 2", "--slug", "AL2", "--json"], ["project", "get", P1, "--human"]] },
  // Kaneo 2.32.0 refuses a key another project in the workspace uses, ignoring
  // case and counting archived projects, with a 409 the CLI passes on.
  {
    name: "a project key another project uses is refused",
    seed: { projects: [...SEED.projects, { id: "proj-old2", workspaceId: WS, name: "Old again", slug: "old" }] },
    steps: [
      ["project", "create", "Alpha two", "--slug", "alp", "--human"],
      // A key the archived project holds (it is the one the reply names), and
      // one in a compatibility form.
      ["project", "create", "Older", "--slug", "OLD", "--human"],
      ["project", "create", "Wide", "--slug", "ＡＬＰ", "--human"],
      // Another workspace's projects do not count.
      ["project", "create", "Elsewhere", "--slug", "ALP", "-w", "ws-other", "--human"],
      ["project", "update", P1, "--slug", "bet", "--human"],
      ["project", "update", P1, "--slug", "alp", "--json"],
      ["project", "unarchive", "proj-old", "--human"],
      // Its own key in another case is not checked, even with another project
      // already holding the same key.
      ["project", "update", "proj-old2", "--slug", "OLD", "--human"],
      ["project", "ls", "--archived", "--human"],
    ],
  },
  { name: "project update clears description", steps: [["project", "update", P1, "-d", "", "--json"]] },
  {
    // The server takes an empty slug, and refusing to write such a project left
    // no way to rename it.
    name: "project update with an empty slug",
    seed: { projects: [...SEED.projects, { id: "proj-noslug", workspaceId: WS, name: "No slug", slug: "" }] },
    steps: [["project", "update", "proj-noslug", "--name", "Has a name now", "--json"]],
  },
  {
    // The read has no slug and the write's reply is the same row, so a slug
    // written cannot be echoed back and is reported as such; a write that
    // leaves it alone still gets its line, with no after to name.
    name: "project update of a project whose read lacks the slug",
    readWithout: ["slug"],
    steps: [
      ["project", "update", P1, "--slug", "AL2", "--human"],
      ["project", "update", P1, "--name", "Alpha 2", "--human"],
    ],
  },
  {
    // Written back unchanged, a field the read lacked still gets its line.
    name: "project update of a project whose read lacks the description",
    readWithout: ["description"],
    steps: [["project", "update", P1, "-d", "", "--human"]],
  },
  {
    name: "project update json of a project whose read lacks the slug",
    readWithout: ["slug"],
    steps: [["project", "update", P1, "--slug", "AL2", "--json"]],
  },
  {
    name: "project update json of a project whose read lacks the description",
    readWithout: ["description"],
    steps: [["project", "update", P1, "-d", "", "--json"]],
  },
  {
    name: "project update json of a project whose read lacks the icon",
    readWithout: ["icon"],
    steps: [["project", "update", P1, "--icon", "Star", "--json"]],
  },
  {
    // A field the read sent as null was read, as no value: the line says null,
    // not "not read".
    name: "project update of a project whose read nulls the icon",
    readAs: { icon: null },
    steps: [["project", "update", P1, "--icon", "Star", "--human"]],
  },
  {
    // The read drops the slug but the write's reply has it: the field line says
    // "(not read)", and the identifier line says whether it changed is unknown
    // rather than claiming it did.
    name: "project update of a project whose read drops only the slug",
    readAs: { slug: undefined },
    steps: [
      ["project", "update", P1, "--slug", "AL2", "--human"],
      ["project", "update", P1, "--slug", "AL3", "--json"],
    ],
  },
  {
    // A field left out, one sent as null and one sent as another type are each
    // named for what the server did.
    name: "project update refuses a read that lacks, nulls and mistypes fields",
    readWithout: ["description"],
    readAs: { icon: null, slug: 5, isPublic: "true" },
    steps: [["project", "update", P1, "--name", "Alpha 2", "--human"]],
  },
  {
    // The order of unread is the order slug, description, icon. The fields are
    // left unwritten so the update can succeed on a server that lacks them.
    name: "project update json of a project whose read lacks every optional field",
    readWithout: ["slug", "description", "icon"],
    steps: [["project", "update", P1, "--name", "Alpha 2", "-d", "", "--json"]],
  },
  // A project whose id the shell would split or expand: the hints quote it.
  {
    name: "hints quote an id the shell would expand",
    seed: {
      projects: [{ id: "p q$(x)", workspaceId: WS, name: "Odd", slug: "ODD" }],
      tasks: [{ id: "task-o1", projectId: "p q$(x)", title: "Held" }],
    },
    steps: [["project", "rm", "ODD", "--human"], ["column", "rm", "to-do", "--yes", "-p", "ODD", "--human"]],
  },
  // A plain member is refused with a bare 403; the line says which permission the
  // route checks and the caller's role there.
  {
    name: "project writes as a plain member",
    plainMember: true,
    seed: { members: [{ id: "user-self", name: "Self", email: "self@example.com", role: "member" }] },
    steps: [
      ["project", "archive", "BET", "--json"],
      ["project", "unarchive", "BET", "--human"],
      ["project", "update", "BET", "--name", "Renamed", "--human"],
      ["project", "rm", "BET", "--yes", "--human"],
      ["project", "reorder", "BET", "ALP", "--human"],
      ["project", "create", "Gamma", "--slug", "GAM", "-d", "about", "--human"],
      ["project", "get", "BET", "--json"],
    ],
  },
  // The role is best effort: without /user/me the line leaves it out.
  {
    name: "project write as a plain member whose role cannot be read",
    plainMember: true,
    noCurrentUser: true,
    steps: [["project", "archive", "BET", "--human"]],
  },
  { name: "project archive and unarchive", steps: [["project", "archive", P2, "--json"], ["project", "ls", "--human"], ["project", "unarchive", P2, "--human"], ["project", "ls", "--json"]] },
  { name: "project rm needs --yes", steps: [["project", "rm", P2, "--human"], ["project", "rm", "Beta", "--yes", "--json"], ["project", "ls", "--human"], ["project", "ls", "--archived", "--human"], ["task", "ls", "-p", P2, "--json"], ["project", "rm", "OLD", "--yes", "--human"]] },
  // KANEO_PROJECT names proj-alpha in every scenario; deleting it leaves the
  // setting pointing at nothing, which the note says before the next command
  // finds out the hard way.
  { name: "project rm of the configured project", steps: [["project", "rm", "ALP", "--yes", "--human"], ["project", "get", "--json"]] },
  // An attached session keeps the project in its attachment too; the note says
  // `session close` is what releases it, and status still shows the hold.
  {
    name: "project rm of the attached session's project",
    env: { KANEO_SESSION_ID: "sess-rm" },
    steps: [
      ["session", "attach", "1", "--strict"],
      ["project", "rm", "ALP", "--yes", "--human"],
      ["session", "status", "--human"],
    ],
  },
  { name: "project rm unknown", steps: [["project", "rm", "nope", "--yes", "--json"]] },
  { name: "project reorder", steps: [["project", "reorder", "Beta", "ALP", "--human"], ["project", "ls", "--archived", "--json"], ["project", "reorder", P1, P2, "--json"], ["project", "reorder", "bet", "alp", "--json"]] },
  { name: "project reorder must name every project", steps: [["project", "reorder", "Alpha", "--json"], ["project", "reorder", "Alpha", "Alpha", "Beta", "--json"], ["project", "reorder", "Alpha", "nope", "Beta", "--json"], ["project", "reorder", "Alpha", "Beta", "Old", "--json"]] },
  // The archived project between two active ones, so the ranks it holds are the
  // ones the request has to fill around: it keeps its place and the other two
  // swap.
  {
    name: "project reorder around an archived project",
    seed: {
      projects: [
        { id: P1, workspaceId: WS, name: "Alpha", slug: "ALP" },
        { id: "proj-old", workspaceId: WS, name: "Old", slug: "OLD", archived: true },
        { id: P2, workspaceId: WS, name: "Beta", slug: "BET" },
      ],
    },
    steps: [["project", "reorder", "Beta", "Alpha", "--human"], ["project", "ls", "--archived", "--json"]],
  },
  // The assignee of task-a2 belongs to the source workspace alone, so the move
  // unassigns it and the reply counts the one it did.
  {
    name: "project move",
    seed: {
      members: [
        { id: "user-self", name: "Self", email: "self@example.com", role: "owner" },
        { id: "user-1", name: "Ada", email: "ada@example.com", role: "member", workspaceId: WS },
      ],
    },
    steps: [
      ["project", "move", P1, "--to", "Other", "--json"],
      ["project", "get", P1, "--human"],
      ["project", "ls", "-w", "ws-other", "--human"],
      ["task", "ls", "-p", P1, "--json"],
    ],
  },
  {
    // proj-taken's key is taken in ws-other, so the move is refused on the
    // conflict rather than on anything else.
    name: "project move refused",
    seed: {
      projects: [
        ...SEED.projects,
        { id: "proj-taken", workspaceId: WS, name: "Taken", slug: "CLASH" },
        { id: "proj-clash", workspaceId: "ws-other", name: "Clash", slug: "clash" },
      ],
    },
    steps: [
      ["project", "move", P1, "--to", "Main", "--json"],
      ["project", "move", P1, "--json"],
      ["project", "move", P1, "--to", "nope", "--json"],
      ["project", "move", "nope", "--to", "Other", "--json"],
      ["project", "move", "proj-taken", "--to", "Other", "--json"],
    ],
  },
  {
    name: "project move as a plain member",
    plainMember: true,
    seed: { members: [{ id: "user-self", name: "Self", email: "self@example.com", role: "member" }] },
    steps: [["project", "move", P1, "--to", "Other", "--json"]],
  },
  {
    // The 403 does not say which workspace's check refused, so the hint names
    // both sides' permissions and the caller's role in each it could read —
    // here a member of the source alone.
    name: "project move refused at the destination",
    moveDeniedTarget: "ws-other",
    seed: { members: [{ id: "user-self", name: "Self", email: "self@example.com", role: "member", workspaceId: WS }] },
    steps: [["project", "move", P1, "--to", "Other", "--json"]],
  },
  // The upload is the web app's three steps: prepare, PUT the bytes to the
  // presigned URL it names, finalize — and get writes them back out untouched.
  {
    name: "project background set get rm",
    files: { "bg.png": "PNG-BYTES-0123456789" },
    steps: [
      ["project", "background", "set", P1, "bg.png", "--json"],
      ["project", "background", "get", "BET"],
      ["project", "background", "get", P1],
      ["project", "background", "get"],
      ["project", "background", "rm", P1, "--yes", "--human"],
      ["project", "background", "get", P1],
    ],
  },
  {
    name: "project background set refused",
    files: { "notes.txt": "not an image", "bg.png": "PNG", "empty.png": "", "blob": "PNG" },
    steps: [
      ["project", "background", "set", P1, "missing.png", "--json"],
      ["project", "background", "set", P1, "notes.txt", "--json"],
      // No extension, so Bun.file().type can only answer octet-stream, which
      // is no image type: refused here rather than sent for the server to
      // refuse. --content-type would override it.
      ["project", "background", "set", P1, "blob", "--json"],
      ["project", "background", "set", P1, "empty.png", "--json"],
      ["project", "background", "set", P1, "bg.png", "--content-type", "image/gif", "--json"],
      ["project", "background", "get", P1, "--json"],
      ["project", "background", "get", P1, "--jq", ".url"],
      ["project", "background", "rm", P1, "--human"],
      ["project", "background", "rm", "nope", "--yes", "--json"],
    ],
  },
  {
    // The finalize is the last of the three upload steps: a refusal there
    // leaves the staged bytes orphaned and the project unchanged.
    name: "project background set finalize refused",
    files: { "bg.png": "PNG-BYTES" },
    failOn: "POST /project/proj-alpha/background-upload/finalize",
    failStatus: 400,
    failMessage: "Image upload could not be finalized",
    steps: [["project", "background", "set", P1, "bg.png", "--json"]],
  },
  {
    // The storage PUT answers outside the API's envelope, in the storage
    // server's own markup — which carries the signature it checked, so only
    // its Code and Message may reach the report.
    name: "project background set storage refused",
    files: { "bg.png": "PNG-BYTES" },
    failOn: "PUT /storage/",
    failStatus: 403,
    failMessage:
      '<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature does not match</Message><StringToSign>AWS4-HMAC-SHA256\n20260101\nshould-not-appear</StringToSign><SignatureProvided>deadbeef</SignatureProvided></Error>',
    steps: [["project", "background", "set", P1, "bg.png", "--json"]],
  },
  {
    name: "project background set from stdin",
    stdin: "STDIN-PNG-BYTES",
    steps: [["project", "background", "set", P1, "-", "--content-type", "image/png", "--json"]],
  },
  {
    name: "project background set from stdin needs a type",
    stdin: "x",
    steps: [["project", "background", "set", P1, "-", "--json"]],
  },
  {
    name: "project background as a plain member",
    plainMember: true,
    seed: { members: [{ id: "user-self", name: "Self", email: "self@example.com", role: "member" }] },
    files: { "bg.png": "PNG" },
    steps: [
      ["project", "background", "set", P1, "bg.png", "--json"],
      ["project", "background", "rm", P1, "--yes", "--json"],
    ],
  },

  ...both("column list", ["column", "list"]),
  { name: "column create and reorder", steps: [["column", "create", "Waiting", "--json"], ["column", "reorder", "to-do", "waiting", "in-progress", "done", "--human"], ["column", "ls", "--json"], ["task", "status", "1", "waiting", "--json"], ["board", "--human"]] },
  { name: "column reorder must name every column", steps: [["column", "reorder", "done", "to-do", "--json"], ["column", "reorder", "to-do", "to-do", "in-progress", "done", "--json"], ["column", "reorder", "to-do", "nope", "in-progress", "done", "--json"]] },
  { name: "column rename", steps: [["column", "rename", "in-progress", "Doing", "--json"], ["column", "ls", "--human"]] },
  // Name, icon, color and done state all move after creation; what is not
  // passed stays, and an empty --icon or --color clears it.
  {
    name: "column update",
    steps: [
      ["column", "update", "in-progress", "--name", "Doing", "--icon", "Clock", "--color", "#f00", "--final", "--json"],
      ["column", "update", "Doing", "--icon", "", "--color", "", "--final=false", "--human"],
      ["column", "ls", "--human"],
      ["column", "update", "done", "--json"],
      ["column", "update", "in-progress", "--name", " ", "--json"],
      ["column", "update", "nope", "--name", "x", "--json"],
    ],
  },
  // A name is matched with its surrounding spaces off and in one normalization
  // form, so a column stored or typed either way is still the one named.
  {
    name: "column names match across spaces and normalization",
    seed: {
      columns: [
        { slug: "to-do", name: "To Do" },
        { slug: "in-progress", name: "In Progress" },
        { slug: "done", name: "Done", isFinal: true },
        { slug: "padded", name: "Padded " },
        // Stored decomposed; the rename below types it composed.
        { slug: "cafe", name: "Café" },
      ],
    },
    steps: [
      ["column", "rm", " Padded", "--yes", "--json"],
      ["column", "rename", "Café", "Coffee", "--json"],
      ["column", "ls", "--human"],
    ],
  },
  // A name two columns share cannot pick one, so the reorder refusal names the
  // ambiguity with the slugs that tell them apart — alongside every other way
  // the list falls short, before anything is written.
  {
    name: "column reorder refuses an ambiguous name",
    seed: {
      columns: [
        { slug: "to-do", name: "To Do" },
        { slug: "in-progress", name: "In Progress" },
        { slug: "done", name: "Done", isFinal: true },
        { slug: "same-a", name: "Same" },
        { slug: "same-b", name: "Same" },
      ],
    },
    steps: [
      ["column", "reorder", "to-do", "in-progress", "done", "Same", "nope", "--json"],
      ["column", "rename", "Same", "x", "--json"],
      ["column", "ls", "--human"],
    ],
  },
  { name: "column rm needs --yes", steps: [["column", "rm", "done", "--human"], ["column", "rm", "done", "--yes", "--json"], ["column", "create", "Waiting", "--json"], ["column", "rm", "waiting", "--yes", "--json"], ["column", "ls", "--json"]] },
  { name: "column unknown", steps: [["column", "rename", "nope", "x", "--json"]] },
  // A rule cannot outlive its column, so the delete takes the rules pointing at
  // it: done holds a task and would be refused, hence a column of this one's own.
  { name: "column rm takes its workflow rules with it", steps: [["column", "create", "Waiting", "--json"], ["workflow", "set", "github", "pr_opened", "waiting", "--json"], ["column", "rm", "waiting", "--yes", "--json"], ["workflow", "ls", "--json"]] },

  { name: "workflow list", seed: { workflowRules: [{ projectId: P1, integrationType: "github", eventType: "pr_merged", columnSlug: "done" }] }, steps: [["workflow", "ls", "--json"], ["workflow", "ls", "--human"]] },
  { name: "workflow list empty", steps: [["workflow", "ls", "--json"], ["workflow", "ls", "--human"]] },
  { name: "workflow set and rm", steps: [["workflow", "set", "github", "pr_opened", "in-progress", "--json"], ["workflow", "set", "github", "pr_opened", "Done", "--human"], ["workflow", "set", "gitea", "issue_closed", "col0003", "--json"], ["workflow", "ls", "--human"], ["workflow", "rm", "github", "pr_opened", "--json"], ["workflow", "ls", "--json"]] },
  // A pair no plugin of the shipped ones fires is stored all the same, and said so
  // on stderr rather than left as a rule that moves nothing.
  {
    name: "workflow set a pair nothing fires",
    steps: [
      ["workflow", "set", "github", "pull_request.opened", "done", "--human"],
      ["workflow", "set", "gerrit", "pr_opened", "done", "--human"],
      // The names are matched exactly, so a case variant is stored as a rule
      // that never fires — with the known name pointed out.
      ["workflow", "set", "GitHub", "pr_opened", "done", "--human"],
      ["workflow", "set", "github", "PR_OPENED", "done", "--human"],
      ["workflow", "ls", "--human"],
    ],
  },
  { name: "workflow rm by id", seed: { workflowRules: [{ projectId: P1, integrationType: "github", eventType: "pr_merged", columnSlug: "done" }] }, steps: [["workflow", "ls", "--json"], ["workflow", "rm", "rule0002", "--human"], ["workflow", "ls", "--json"]] },
  { name: "workflow rm by pair matches the event", seed: { workflowRules: [{ projectId: P1, integrationType: "github", eventType: "pr_merged", columnSlug: "done" }, { projectId: P1, integrationType: "github", eventType: "pr_opened", columnSlug: "in-progress" }] }, steps: [["workflow", "rm", "github", "pr_opened", "--human"], ["workflow", "ls", "--human"]] },
  // Every integration fires the same six events, so a pair's integration is what
  // tells two rules apart.
  { name: "workflow rm by pair matches the integration", seed: { workflowRules: [{ projectId: P1, integrationType: "github", eventType: "pr_opened", columnSlug: "in-progress" }, { projectId: P1, integrationType: "gitea", eventType: "pr_opened", columnSlug: "done" }] }, steps: [["workflow", "rm", "gitea", "pr_opened", "--human"], ["workflow", "ls", "--human"]] },
  // Nothing on the server keeps a pair to one rule, so a project can hold two, and
  // deleting one of them would leave the other live: both are named instead.
  { name: "workflow rm refuses a pair it finds twice", seed: { workflowRules: [{ projectId: P1, integrationType: "github", eventType: "pr_opened", columnSlug: "in-progress" }, { projectId: P1, integrationType: "github", eventType: "pr_opened", columnSlug: "done" }] }, steps: [["workflow", "rm", "github", "pr_opened", "--json"], ["workflow", "ls", "--human"]] },
  { name: "project reorder prefers an active project over an archived namesake", seed: { projects: [{ id: P1, workspaceId: WS, name: "Alpha", slug: "ALP" }, { id: P2, workspaceId: WS, name: "Beta", slug: "BET" }, { id: "proj-gone", workspaceId: WS, name: "Beta", slug: "beta", archived: true }] }, steps: [["project", "reorder", "Beta", "Alpha", "--human"], ["project", "reorder", "alpha", "bet", "--human"]] },
  { name: "workflow rm by id needs no project", env: { KANEO_PROJECT: "" }, seed: { workflowRules: [{ projectId: P2, integrationType: "github", eventType: "pr_merged", columnSlug: "done" }] }, steps: [["workflow", "rm", "rule0002", "--human"], ["workflow", "ls", "--json"]] },
  { name: "workflow rm by id reports other failures as they are", whitespaceOn: "^DELETE /workflow-rule/", steps: [["workflow", "rm", "rule0002", "--json"]] },
  { name: "workflow refused", steps: [["workflow", "set", "github", "pr_opened", "nope", "--json"], ["workflow", "set", "github", "pr_opened", "--json"], ["workflow", "set", "", "pr_opened", "done", "--json"], ["workflow", "set", "github", "", "done", "--json"], ["workflow", "rm", "github", "pr_opened", "--json"], ["workflow", "rm", "rule9999", "--json"], ["workflow", "rm", " ", "--json"], ["column", "create", "Waiting", "on", "review", "--json"], ["workflow", "set", "github", "pr_opened", "Waiting", "on", "review", "--human"]] },
  { name: "column by id and name", steps: [["column", "rename", "col0002", "Doing", "--json"], ["column", "reorder", "col0001", "done", "Doing", "--human"]] },
  { name: "column create with flags", steps: [["column", "create", "外部回答", "待ち", "--final", "--icon", "Clock", "--color", "#f00", "--json"], ["column", "rename", "外部回答-待ち", "Waiting", "on", "review", "--json"], ["column", "ls", "--human"]] },
  { name: "column names refused", steps: [["column", "create", "Planned", "--json"], ["column", "create", "!!!", "--json"], ["column", "create", "To Do", "--json"], ["column", "create", " ", "--json"], ["column", "rename", "to-do", " ", "--json"], ["column", "rename", "in-progress", "To Do", "--json"], ["column", "rename", "To Do", "x", "--json"]] },

  ...both("field list", ["field", "ls"]).map((s): Scenario => ({ ...s, seed: FIELD_SEED })),
  {
    name: "field add",
    seed: FIELD_SEED,
    steps: [
      ["field", "add", "QA", "owner", "--type", "text", "--json"],
      ["field", "add", "Ships in", "--type", "dropdown", "--options", "Web, CLI, Mobile", "--required", "--default", "Web", "--json"],
      ["field", "ls", "--human"],
      ["field", "values", "--human"],
    ],
  },
  {
    // What the server refuses on create, in its own words: a choice field
    // without options, a required field without a default, a default that does
    // not fit its type.
    name: "field add refused",
    steps: [
      ["field", "add", "No type", "--json"],
      ["field", "add", "Choice", "--type", "dropdown", "--json"],
      ["field", "add", "Must", "--type", "text", "--required", "--json"],
      ["field", "add", "Bad num", "--type", "number", "--default", "abc", "--json"],
      ["field", "add", "Bad bool", "--type", "boolean", "--default", "yes", "--json"],
      ["field", "ls", "--json"],
    ],
  },
  {
    name: "field values",
    seed: FIELD_SEED,
    steps: [
      ["field", "values", "--json"],
      ["field", "values", "--human"],
      ["field", "values", "Release", "--json"],
      ["field", "values", "Story points", "--human"],
      ["field", "values", "nope", "--json"],
    ],
  },
  {
    name: "task field",
    seed: FIELD_SEED,
    steps: [
      ["task", "field", "1", "--json"],
      ["task", "field", "ALP#2", "Release", "CLI", "--human"],
      ["task", "field", "2", "--json"],
      ["task", "field", "1", "Priority note", "ship", "it", "--json"],
      ["task", "field", "1", "--human"],
      ["task", "create", "Fresh", "--json"],
      ["task", "field", "4", "--json"],
      ["task", "field", "1", "Release", "Mobile", "--json"],
      ["task", "field", "1", "Story points", "abc", "--json"],
      ["task", "field", "1", "nope", "x", "--json"],
      ["task", "field", "1", "Priority note", "--json"],
    ],
  },
  {
    name: "task field multiselect",
    seed: FIELD_SEED,
    steps: [
      ["field", "add", "Tags", "--type", "multiselect", "--options", "a, b, c", "--json"],
      ["task", "field", "1", "Tags", '["a","c"]', "--json"],
      ["task", "field", "1", "Tags", "not json", "--json"],
      ["task", "field", "1", "Tags", '["a","zzz"]', "--json"],
      ["task", "field", "1", "--human"],
      ["field", "values", "Tags", "--json"],
    ],
  },
  {
    name: "field reorder",
    seed: FIELD_SEED,
    steps: [
      ["field", "reorder", "Release", "Priority note", "Story points", "--json"],
      ["field", "ls", "--human"],
      ["field", "reorder", "Release", "Priority note", "--json"],
      ["field", "reorder", "Release", "nope", "Story points", "--json"],
      ["field", "reorder", "Release", "Release", "Story points", "--json"],
    ],
  },
  {
    name: "field rm",
    seed: FIELD_SEED,
    steps: [
      ["field", "rm", "Story points", "--human"],
      ["field", "rm", "Story points", "--yes", "--json"],
      ["field", "ls", "--human"],
      ["task", "field", "1", "--json"],
      ["field", "rm", "nope", "--yes", "--json"],
    ],
  },
  {
    // The server keeps no uniqueness on names, so a shared one is refused by id
    // rather than guessed — on delete and on the filter-values pick alike.
    name: "field names refused",
    seed: {
      customFields: [
        { projectId: P1, name: "Note", type: "text" },
        { projectId: P1, name: "Note", type: "text" },
      ],
    },
    steps: [
      ["field", "rm", "Note", "--yes", "--json"],
      ["field", "values", "Note", "--json"],
      ["field", "rm", "fld0001", "--yes", "--json"],
      ["field", "ls", "--json"],
    ],
  },
  {
    // A value the seed names for a task replaces the default the field's
    // backfill wrote for it — one row, not two — and a deleted task's values
    // leave the filter candidates, singly and in bulk.
    name: "field values leave with their task",
    seed: {
      customFields: [{ projectId: P1, name: "Env", type: "text", defaultValue: "prod" }],
      customFieldValues: [
        { taskId: "task-a1", field: "Env", value: "staging" },
        { taskId: "task-a3", field: "Env", value: "dev" },
      ],
    },
    steps: [
      ["task", "field", "1", "--json"],
      ["task", "rm", "1", "--yes", "--json"],
      ["field", "values", "Env", "--json"],
      ["task", "bulk", "2", "3", "--delete", "--yes", "--json"],
      ["field", "values", "Env", "--json"],
    ],
  },

  ...both("search", ["search", "first"]),
  // A task other than #1, so a number that only happened to be 1 is caught.
  { name: "search gives a task match its number", steps: [["search", "Ship", "--type", "tasks", "--json"]] },
  { name: "search narrowed", steps: [["search", "first", "--in-project", "--json"], ["search", "first", "-p", "BET", "--human"], ["search", "first", "--in-project", "-p", "nope", "--human"], ["search", "a", "--in-project", "--type", "projects", "--human"], ["search", "e", "--type", "tasks", "--limit", "1", "--json"], ["search", "e", "--limit", "50", "--human"], ["search", "beta", "--type", "projects", "--human"], ["search", "e", "--limit", "2", "--human"], ["search", "x", "--type", "bogus", "--json"], ["search", " ", "--json"]] },
  { name: "search at the server's limit", seed: { tasks: Array.from({ length: 50 }, (_, i) => ({ id: `task-m${i}`, projectId: P1, title: `match ${i}` })) }, steps: [["search", "match", "--type", "tasks", "--limit", "50", "--human"], ["search", "match", "-A", "--type", "tasks", "--human"], ["search", "match", "-A", "--type", "tasks", "--limit", "50", "--human"]] },
  { name: "search and members need a workspace", env: { KANEO_WORKSPACE: "" }, steps: [["search", "first", "--json"], ["workspace", "members", "--json"]] },
  { name: "search across workspaces needs none", env: { KANEO_WORKSPACE: "" }, steps: [["search", "first", "-A", "--human"]] },
  {
    // Fifty members make the server fill each workspace's page of 50 with
    // repeats of "Other", so the tasks that match are pushed out: the output has
    // to say there may be more although only one match is left.
    name: "search across workspaces filled by repeats",
    seed: { members: Array.from({ length: 50 }, (_, i) => ({ id: `user-m${i}`, name: `M${i}`, email: `m${i}@example.com`, role: "member" })) },
    steps: [["search", "er", "-A", "--human"]],
  },
  {
    // A project in the second workspace whose task matches alone ("elsewhere") and
    // alongside the first workspace's ("first"), so the merge, its ranking and the
    // cut to --limit across workspaces all show in the output. Two members make
    // the server repeat each workspace match, which fills a page of --limit 2 for
    // "er" with "Other" alone unless every workspace is asked for a full page.
    name: "search across workspaces",
    seed: {
      members: MEMBERS,
      projects: [...SEED.projects, { id: "proj-gamma", workspaceId: "ws-other", name: "Gamma", slug: "GAM" }],
      tasks: [...SEED.tasks, { id: "task-g1", projectId: "proj-gamma", title: "Filed elsewhere first", priority: "low" }],
    },
    steps: [["search", "elsewhere", "--json"], ["search", "elsewhere", "-A", "--human"], ["search", "first", "--all-workspaces", "--json"], ["search", "first", "-A", "--limit", "2", "--human"], ["search", "first", "-A", "--in-project", "--json"], ["search", "first", "-A", "-p", "BET", "--human"], ["search", "other", "-A", "--type", "workspaces", "--json"], ["search", "er", "-A", "--limit", "2", "--human"], ["search", "first", "-A", "--limit", "1", "--json"], ["search", "x", "-A", "--limit", "0", "--json"], ["search", "x", "-A", "--limit", "51", "--human"], ["search", "x", "-A", "--limit", "1.5", "--human"], ["search", "first", "-A", "--limit", "3", "--human"], ["search", "er", "--limit", "3", "--human"], ["search", "er", "--limit", "2", "--json"]],
  },
  ...both("workspace members", ["workspace", "members"]).map((s) => ({ ...s, seed: { members: MEMBERS } })),
  { name: "workspace members by name", seed: { members: MEMBERS }, env: { KANEO_WORKSPACE: "Other" }, steps: [["workspace", "members", "--human"]] },
  { name: "invitation get", seed: { invitations: INVITATIONS }, steps: [["invitation", "get", "inv-open", "--json"], ["invitation", "get", "inv-open", "--human"], ["invitation", "get", "inv-expired", "--json"], ["invitation", "get", "inv-expired", "--human"], ["invitation", "get", "inv-accepted", "--json"], ["invitation", "get", "inv-canceled", "--human"], ["invitation", "get", "inv-boundary", "--human"], ["invitation", "get", "nope", "--human"]] },

  ...both("task list", ["task", "list"]),
  ...both("task list all", ["task", "ls", "--all"]),
  ...both("task list by status", ["task", "ls", "--status", "in-progress"]),
  ...both("task list by priority", ["task", "ls", "--priority", "high"]),
  { name: "task list filters on the server", steps: [["task", "ls", "--status", "in-progress", "--priority", "no-priority", "--json"]] },
  // What is printed does not rest on the server having applied the filters.
  { name: "task list filters what the server did not", ignoreFilters: true, steps: [["task", "ls", "--status", "in-progress", "--json"], ["task", "ls", "--priority", "high", "--json"]] },
  // The listing answers the tasks in no column beside the columns: both are
  // hidden unless asked for by name, and neither counts as work on the board.
  {
    name: "planned and archived tasks",
    extraTasks: [
      { id: "task-a4", projectId: P1, title: "Next quarter", status: "planned" },
      { id: "task-a5", projectId: P1, title: "Last year's plan", status: "archived" },
    ],
    steps: [["task", "ls", "--json"], ["task", "ls", "--all", "--human"], ["task", "ls", "--status", "planned", "--json"], ["task", "get", "5", "--json"], ["board", "--json"]],
  },
  {
    name: "task list of my tasks across projects",
    extraTasks: [
      { id: "task-m1", projectId: P1, title: "Mine in alpha", priority: "high", userId: "user-self" },
      { id: "task-m2", projectId: "proj-beta", title: "Mine in beta", status: "in-progress", userId: "user-self" },
      { id: "task-m3", projectId: P1, title: "Mine but done", status: "done", userId: "user-self" },
    ],
    steps: [["task", "ls", "--mine", "--json"], ["task", "ls", "--mine", "--human"]],
  },
  {
    name: "task list of my tasks says when the server cut it",
    assignedLimit: 1,
    extraTasks: [
      { id: "task-m1", projectId: P1, title: "Mine in alpha", userId: "user-self" },
      { id: "task-m2", projectId: P1, title: "Mine too", userId: "user-self" },
    ],
    steps: [["task", "ls", "--mine", "--human"], ["task", "ls", "--mine", "--json"]],
  },
  { name: "task list of my tasks refuses a filter", steps: [["task", "ls", "--mine", "--status", "done"], ["task", "ls", "--mine", "--priority", "high"], ["task", "ls", "--mine", "--all"]] },
  {
    name: "task list says how many it left out",
    extraTasks: [
      { id: "task-a4", projectId: P1, title: "Next quarter", status: "planned" },
      { id: "task-a5", projectId: P1, title: "Last year's plan", status: "archived" },
    ],
    steps: [
      ["task", "ls", "--human"],
      ["task", "ls", "--all", "--human"],
      ["task", "ls", "--json"],
      ["task", "ls", "--jq", ".[].number"],
      ["task", "ls", "--status", "planned", "--json"],
      // A filter that fails at run time: the notice comes before jq's error.
      ["task", "ls", "--jq", "error(\"boom\")"],
    ],
  },
  // The count under --priority: the seed's done task has no priority and is
  // not counted, so high reads 2 and low reads 1. The fake filters by priority
  // before the CLI counts, so this does not show the CLI applying the filter
  // itself; "counts under a priority the server did not apply" below is what
  // shows that.
  {
    name: "task list says how many it left out under a priority",
    extraTasks: [
      { id: "task-a4", projectId: P1, title: "Next quarter", status: "planned", priority: "high" },
      { id: "task-a5", projectId: P1, title: "Last year's plan", status: "archived", priority: "high" },
      { id: "task-a6", projectId: P1, title: "Shelved", status: "archived", priority: "low" },
    ],
    steps: [["task", "ls", "--priority", "high", "--human"], ["task", "ls", "--priority", "low", "--human"]],
  },
  // The server's filtering is not relied on for the count either: handed the
  // whole board, only the high-priority hidden tasks are counted.
  {
    name: "task list counts under a priority the server did not apply",
    ignoreFilters: true,
    extraTasks: [
      { id: "task-a4", projectId: P1, title: "Next quarter", status: "planned", priority: "high" },
      { id: "task-a5", projectId: P1, title: "Shelved", status: "archived", priority: "low" },
    ],
    steps: [["task", "ls", "--priority", "high", "--human"]],
  },
  // Nothing hidden, nothing said.
  {
    name: "task list with nothing left out",
    steps: [["task", "ls", "--status", "to-do", "--human"], ["task", "ls", "--priority", "high", "--json"]],
  },
  ...both("task get by number", ["task", "get", "1"]),
  // A description above 64 KiB is left out of the listing, so resolving the task
  // by number reads it from the task detail.
  {
    name: "deferred description",
    // The second is under 64 Ki characters but over 64 KiB, which is what the
    // server measures; that step holds the fake to the server, since the CLI
    // trusts the flag and measures nothing. The write after them reads no
    // description: only task get pays for one.
    extraTasks: [
      { id: "task-a4", projectId: P1, title: "A long story", description: "x".repeat(64 * 1024 + 1) },
      { id: "task-a5", projectId: P1, title: "A long story in kana", description: "あ".repeat(30_000) },
    ],
    // The listings mark a deferred description rather than fetching it, so the
    // JSON tells it apart from a genuinely empty one.
    steps: [
      ["task", "get", "4", "--json"],
      ["task", "get", "5", "--json"],
      ["task", "ls", "--json"],
      ["board", "--json"],
      ["task", "status", "4", "done", "--json"],
    ],
  },
  // A number is looked up on the page that holds it, so a board past one page
  // costs the first page rather than all of them.
  { name: "task get stops paging early", pageSize: 2, steps: [["task", "get", "1", "--json"]] },
  // A task past the first page is still found, and the pages after it are not read.
  { name: "task get on a later page", pageSize: 1, steps: [["task", "get", "2", "--json"]] },
  ...both("task get by id", ["task", "get", "task-a2"]),
  ...both("task get unknown", ["task", "get", "99"]),
  { name: "task get with no relations", steps: [["task", "get", "2", "--json"]] },
  { name: "task create", steps: [["task", "create", "New one", "-d", "body", "--priority", "low", "--json"], ["task", "ls", "--human"]] },
  { name: "task create assigned", seed: { members: MEMBERS }, steps: [["task", "create", "Mine", "--assignee", "user-1", "--status", "in-progress", "--human"], ["task", "get", "4", "--json"]] },
  { name: "task create bad priority", steps: [["task", "create", "x", "--priority", "huge", "--json"]] },
  // --title gives the title as task update takes it; given with words too, or
  // with neither, the create is refused before anything is asked.
  { name: "task create with --title", steps: [["task", "create", "--title", "Flagged one", "--json"], ["task", "ls", "--human"]] },
  { name: "task create with --title and words", steps: [["task", "create", "Words", "--title", "Flagged", "--json"], ["task", "ls", "--human"]] },
  { name: "task create with no title", steps: [["task", "create", "--json"]] },
  // An empty --title is refused as task update refuses it, and an empty one
  // beside words still counts as giving the title twice.
  { name: "task create with an empty --title", steps: [["task", "create", "--title", " ", "--json"], ["task", "create", "--title", "", "--json"], ["task", "create", "Words", "--title", "", "--json"], ["task", "ls", "--human"]] },
  // Words that are blank make a blank title, refused as --title is. A title
  // refused is said before a missing key, as task update says it.
  { name: "task create with blank words", steps: [["task", "create", " ", "--json"], ["task", "create", "", "--json"], ["task", "create", "a", "b", "--json"], ["task", "ls", "--human"]] },
  { name: "task create with an empty --title and no key", env: { KANEO_API_KEY: "" }, steps: [["task", "create", "--title", "", "--json"], ["task", "create", " ", "--json"], ["task", "create", "Words", "--json"]] },
  // Taken as task update takes it, and refused before the create when it is not
  // a date or comes after the due date.
  {
    name: "task create with a start date",
    steps: [
      ["task", "create", "Planned", "--start-date", "2026-01-01", "--due-date", "2026-01-01T12:00:00Z", "--json"],
      ["task", "get", "4", "--human"],
      ["task", "create", "Late", "--start-date", "2026-01-01T13:00:00+00:00", "--due-date", "2026-01-01T12:00:00Z", "--json"],
      ["task", "create", "Vague", "--start-date", "next week", "--json"],
      ["task", "create", "Someday", "--due-date", "someday", "--json"],
      ["task", "create", "Same day", "--start-date", "2026-01-01T12:00:00Z", "--due-date", "2026-01-01T12:00:00Z", "--human"],
      ["task", "ls", "--human"],
    ],
  },
  { name: "task update title and description", steps: [["task", "update", "1", "--title", "Renamed", "-d", "new body", "--json"], ["task", "get", "1", "--human"]] },
  { name: "task update status and priority", steps: [["task", "edit", "2", "--status", "done", "--priority", "low", "--human"], ["task", "ls", "--all", "--json"]] },
  { name: "task update clears the description", steps: [["task", "update", "1", "-d", "", "--json"]] },
  { name: "task update with nothing to change", steps: [["task", "update", "1", "--json"]] },
  // --assignee takes what task assign takes, an empty one clears it, and a name
  // that matches no member is refused before any field is written.
  {
    name: "task update assignee",
    seed: { members: MEMBERS },
    steps: [
      ["task", "update", "1", "--assignee", "ada", "--title", "Renamed", "--json"],
      ["task", "update", "2", "--assignee", "", "--json"],
      ["task", "update", "1", "--assignee", "  ", "--json"],
      ["task", "update", "1", "--assignee", "Nobody", "--title", "Other", "--json"],
      ["task", "get", "1", "--json"],
      ["task", "get", "2", "--json"],
    ],
  },
  { name: "task update start date and position keep the rest", steps: [["task", "due", "2", "2026-11-01", "--json"], ["task", "update", "2", "--start-date", "2026-10-20", "--position", "5", "--json"], ["task", "get", "2", "--json"], ["task", "get", "2", "--human"], ["task", "update", "2", "--position", "6", "--human"], ["task", "update", "2", "--start-date", "", "--human"], ["task", "get", "2", "--json"]] },
  { name: "task update start after the due date changes nothing", steps: [["task", "due", "1", "2026-11-01", "--json"], ["task", "update", "1", "--title", "Renamed", "--start-date", "2026-11-02", "--json"], ["task", "get", "1", "--json"]] },
  // Dates on 2026-01-01, which the recorder leaves as they are, so the instant
  // each one is sent as shows in the golden.
  {
    name: "task dates are sent as instants",
    stdin: '[{"title":"Dated","status":"to-do","dueDate":"2026-01-01T12:00+09:00"}]',
    steps: [
      ["task", "update", "1", "--start-date", "2026-01-01T09:00+09:00", "--json"],
      ["task", "due", "1", "2026-01-01T18:00:00+09:00", "--json"],
      ["task", "bulk", "1", "--due", "2026-01-01", "--json"],
      ["task", "import", "-", "--json"],
    ],
  },
  { name: "task update position with a stored start past the due date changes nothing", steps: [["task", "update", "1", "--start-date", "2026-11-05", "--json"], ["task", "due", "1", "2026-11-01", "--json"], ["task", "update", "1", "--title", "Renamed", "--position", "3", "--json"], ["task", "get", "1", "--json"], ["task", "update", "1", "--title", "Renamed", "--json"]] },
  {
    name: "task dates need a calendar date or an offset",
    steps: [
      ["task", "update", "1", "--start-date", "2026-10-20T09:00:00", "--json"],
      ["task", "update", "1", "--start-date", "1", "--json"],
      ["task", "update", "1", "--start-date", "2026-02-30", "--json"],
      ["task", "update", "1", "--start-date", "  ", "--json"],
      ["task", "due", "1", "October", "--json"],
      ["task", "bulk", "1", "--due", "2026-10-22T09:00", "--json"],
    ],
  },
  { name: "task update position with a title", steps: [["task", "update", "1", "--title", "Renamed", "--position", "3", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task update bad start date or position changes nothing", steps: [["task", "update", "1", "--title", "x", "--start-date", "soon", "--json"], ["task", "update", "1", "--title", "x", "--position", "-1", "--json"], ["task", "update", "1", "--position", "1.5", "--json"], ["task", "update", "1", "--position", "2147483647", "--json"], ["task", "get", "1", "--json"]] },
  { name: "task update bad priority changes nothing", steps: [["task", "update", "1", "--title", "x", "--priority", "huge", "--json"], ["task", "get", "1", "--json"]] },
  { name: "task update bad status changes nothing", steps: [["task", "update", "1", "--title", "x", "--status", "nope", "--json"], ["task", "get", "1", "--json"]] },
  { name: "task update empty status", steps: [["task", "update", "1", "--status", "", "--json"]] },
  { name: "task update empty title", steps: [["task", "update", "1", "--title", " ", "--json"]] },
  { name: "task update json matches task get", steps: [["task", "update", "1", "--priority", "low", "--json"], ["task", "get", "1", "--json"]] },
  { name: "task update description from stdin", stdin: "line one\nline two\n", steps: [["task", "update", "1", "-d", "-", "--json"]] },
  { name: "task update empty stdin", stdin: "", steps: [["task", "update", "1", "-d", "-", "--json"]] },
  { name: "task update blank stdin", stdin: " \n\t\n", steps: [["task", "update", "1", "-d", "-", "--json"]] },
  { name: "task update typed blank description", steps: [["task", "update", "1", "-d", "  ", "--json"]] },
  {
    name: "task update description from a file",
    files: { "body.md": "# Heading\n\n$HOME and `ticks`\n" },
    steps: [["task", "update", "1", "--description-file", "body.md", "--json"]],
  },
  { name: "task update empty file", files: { "e.md": "" }, steps: [["task", "update", "1", "--description-file", "e.md", "--json"]] },
  { name: "task update description twice", files: { "body.md": "x" }, steps: [["task", "update", "1", "-d", "a", "--description-file", "body.md", "--json"]] },
  { name: "task update missing file", steps: [["task", "update", "1", "--description-file", "nope.md", "--json"]] },
  { name: "task update to archived", steps: [["task", "update", "1", "--status", "archived", "--json"]] },
  { name: "task update reports what landed", failOn: "^PUT /task/title/", steps: [["task", "update", "1", "--status", "done", "--title", "x", "--json"]] },
  { name: "task update read-back mismatch", misstoreOn: "^PUT /task/title/", steps: [["task", "update", "1", "--title", "x", "--json"]] },
  { name: "task update description read-back mismatch", misstoreOn: "^PUT /task/description/", steps: [["task", "update", "1", "-d", "abc", "--json"]] },
  { name: "task update read-back fails", failOn: "^GET /task/task-a1$", steps: [["task", "update", "1", "--priority", "low", "--json"]] },
  { name: "task create description from stdin", stdin: "from stdin\n", steps: [["task", "create", "Piped", "-d", "-", "--json"]] },
  // The marker, the attachment and the hook are `session attach`'s, reached in the
  // same command: the new number never has to be carried by hand to the next one.
  {
    name: "task create --attach",
    env: { KANEO_SESSION_ID: "sess-create" },
    steps: [["task", "create", "Brand new", "--attach", "--next", "start", "--json"], ["board", "--json"]],
  },
  // The hook is part of the attach, whichever command was reached for it: a
  // create that attached without running one leaves a statusline holding a task
  // that never told it about itself.
  {
    name: "task create --attach runs the attach hook",
    env: { KANEO_SESSION_ID: "sess-create" },
    config: {
      hooks: {
        attach: 'printf "%s %s %s %s\\n" "$KANEO_HOOK_EVENT" "$KANEO_TASK_ID" "$KANEO_TASK_NUMBER" "$KANEO_TASK_REF" >> "$HOME/.config/kaneo/hook.out"',
      },
    },
    steps: [["task", "create", "Brand new", "--attach", "--next", "start", "--json"]],
  },
  // Checked before the create rather than after it, so nothing is left behind.
  { name: "task create --attach without a session", steps: [["task", "create", "x", "--attach", "--json"], ["task", "ls", "--all", "--json"]] },
  { name: "task create --next without --attach", steps: [["task", "create", "x", "--next", "y", "--json"]] },
  // The flag having been passed decides it, not what it holds.
  { name: "task create --next empty without --attach", steps: [["task", "create", "x", "--next", "", "--json"], ["task", "ls", "--all", "--json"]] },
  // The attach fails once the task exists, so the message has to name what is
  // already on the board to close.
  {
    name: "task create --attach when the attach fails",
    env: { KANEO_SESSION_ID: "sess-create" },
    failOn: "^POST /comment/",
    steps: [["task", "create", "Brand new", "--attach", "--json"], ["task", "ls", "--all", "--json"]],
  },
  // Alike wording warns where a shared reference refuses: measured over real
  // boards alike wording flagged distinct work seven times out of ten, while
  // every pair that shared a reference was the same issue.
  {
    name: "task create warns about a similar title",
    steps: [["task", "create", "Write the parser again", "--json"], ["task", "ls", "--all", "--json"]],
  },
  {
    name: "task create with a shared reference",
    steps: [["task", "create", "Fix owner/repo#7 crash", "--force", "--json"], ["task", "create", "Follow up on owner/repo#7", "--json"]],
  },
  // A spaced reference counts only right after an opening parenthesis: outside one
  // `name #N` is as often a word and a number ("PR #314"), so it is created.
  {
    name: "task create with a spaced reference outside parentheses",
    steps: [["task", "create", "Fix ccx#7 crash", "--force", "--json"], ["task", "create", "Follow up ccx #7", "--human"]],
  },
  {
    name: "task create with a spaced reference in parentheses",
    steps: [["task", "create", "Fix ccx#7 crash", "--force", "--json"], ["task", "create", "Follow up (ccx #7)", "--human"]],
  },
  // Every reference inside one pair of parentheses counts, so the second one
  // is not dropped, and the refusal names it as the title wrote it.
  {
    name: "task create with two references in one pair of parentheses",
    steps: [["task", "create", "Fix ccx#7 crash", "--force", "--json"], ["task", "create", "Follow up (ccx #7 and alp #3)", "--human"]],
  },
  // Finished work is the project's own final columns, not a fixed list of
  // status names: `released` marked final closes the task naming ccx#9, while
  // `done` not marked final leaves the one naming ccx#8 open and blocking.
  {
    name: "task create judges finished work by the project's final columns",
    seed: {
      columns: [
        { slug: "to-do", name: "To Do" },
        { slug: "in-progress", name: "In Progress" },
        { slug: "done", name: "Done" },
        { slug: "released", name: "Released", isFinal: true },
      ],
    },
    extraTasks: [
      { id: "task-rel", projectId: P1, title: "Fix ccx#9 crash", status: "released" },
      { id: "task-dn", projectId: P1, title: "Fix ccx#8 crash", status: "done" },
    ],
    steps: [
      ["task", "create", "Follow up ccx#9", "--json"],
      ["task", "create", "Follow up ccx#8", "--json"],
      ["board", "--human"],
    ],
  },
  {
    name: "task create --attach with a session id the store refuses",
    env: { KANEO_SESSION_ID: "a/b" },
    steps: [["task", "create", "x", "--attach", "--json"], ["task", "ls", "--all", "--json"]],
  },
  { name: "task status", steps: [["task", "status", "1", "done", "--json"], ["task", "get", "1", "--human"]] },
  { name: "task priority", steps: [["task", "priority", "1", "urgent", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task assign and clear", seed: { members: MEMBERS }, steps: [["task", "assign", "1", "user-1", "--json"], ["task", "assign", "1", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task assign by name and me", seed: { members: MEMBERS }, steps: [["task", "assign", "1", "ada", "--human"], ["task", "assign", "1", "me", "--human"], ["task", "get", "1", "--json"]] },
  {
    name: "task assign refuses an unknown or shared name",
    seed: { members: [...MEMBERS!, { id: "user-2", name: "Ada", email: "ada2@example.com", role: "member" }] },
    steps: [["task", "assign", "1", "Nobody", "--json"], ["task", "assign", "1", "ada", "--json"], ["task", "get", "1", "--json"]],
  },
  { name: "task assign by id needs no configured workspace", env: { KANEO_WORKSPACE: "" }, seed: { members: MEMBERS }, steps: [["task", "assign", "1", "user-1", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task assign stops when the project read has no workspace", readWithout: ["workspaceId"], seed: { members: MEMBERS }, steps: [["task", "assign", "1", "ada", "--json"]] },
  { name: "task assign names the project read that failed", failOn: "^GET /project/proj-alpha$", failStatus: 403, seed: { members: MEMBERS }, steps: [["task", "assign", "1", "ada", "--json"]] },
  // A 401 a command wraps in its own words still says it may be the rate limit.
  { name: "a wrapped 401 keeps the rate limit hint", failOn: "^GET /project/proj-alpha$", failStatus: 401, seed: { members: MEMBERS }, steps: [["task", "assign", "1", "ada", "--human"]] },
  { name: "task assign me on a server without user me", noCurrentUser: true, steps: [["task", "assign", "1", "me", "--json"]] },
  // A 404 that says the user is not found is the server answering about the
  // key's user, not a server without the route, so it is not called an old
  // server, and the refusal says what to give instead.
  { name: "task assign me says what to give when the server has no user for the key", failOn: "^GET /user/me$", failStatus: 404, failMessage: "User not found", steps: [["task", "assign", "1", "me", "--json"]] },
  // Any other failure of /user/me is the server's own answer, passed on as it is.
  { name: "task assign me passes on another failure of the user read", failOn: "^GET /user/me$", failStatus: 500, steps: [["task", "assign", "1", "me", "--json"]] },
  // The server's answer for a project it cannot place, beside the 403 above.
  {
    name: "task assign names the project read the server could not place",
    failOn: "^GET /project/proj-alpha$",
    failStatus: 400,
    failMessage: "Workspace ID could not be determined",
    seed: { members: MEMBERS },
    steps: [["task", "assign", "1", "ada", "--json"]],
  },
  // The members are those of the workspace the task is in, not the configured one.
  {
    name: "task assign uses the workspace of the task",
    env: { KANEO_WORKSPACE: "ws-other" },
    seed: { members: [{ id: "user-1", name: "Ada", email: "ada@example.com", role: "member", workspaceId: WS }, { id: "user-9", name: "Zed", email: "zed@example.com", role: "member", workspaceId: "ws-other" }] },
    steps: [["task", "assign", "1", "ada", "--human"], ["task", "assign", "1", "Zed", "--json"], ["task", "get", "1", "--json"]],
  },
  { name: "task assign trims the name", seed: { members: MEMBERS }, steps: [["task", "assign", "1", " ada ", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task assign refuses an empty user", seed: { members: MEMBERS }, steps: [["task", "assign", "1", "", "--json"], ["task", "get", "1", "--json"]] },
  // Task 2 already has an assignee, which a refused name must leave alone.
  {
    name: "task assign keeps the assignee when the name is refused",
    seed: { members: [...MEMBERS!, { id: "user-2", name: "Ada", email: "ada2@example.com", role: "member" }] },
    steps: [["task", "assign", "2", "Nobody", "--json"], ["task", "assign", "2", "ada", "--json"], ["task", "get", "2", "--json"]],
  },
  { name: "task assign me stops without a user id", blankCurrentUserId: true, steps: [["task", "assign", "2", "me", "--json"], ["task", "get", "2", "--json"]] },
  // Every write reads the task back and prints that, so a value the server did not
  // take cannot print as one it did. The assignment is read as a person reads it:
  // the name the server resolved the id to, rather than the id behind it.
  {
    name: "writes read back",
    seed: { members: MEMBERS },
    steps: [["task", "status", "1", "in-progress", "--json"], ["task", "priority", "1", "low", "--human"], ["task", "assign", "1", "user-1", "--human"]],
  },
  // The labels of the task the write resolved come along with the read-back, since
  // only the board listing carries them: a report that dropped or replaced them
  // would show a labeled task as carrying none.
  {
    name: "Labels carried over",
    extraTasks: [{ id: "task-a4", projectId: P1, title: "Needs triage" }],
    seed: { labels: [{ taskId: "task-a4", name: "bug" }] },
    steps: [["task", "status", "4", "in-progress", "--json"]],
  },
  // The server answers the write and keeps the old value: what was sent must not
  // print as what the task holds.
  {
    name: "a write the server did not keep",
    writesNotKept: true,
    seed: { members: MEMBERS },
    steps: [["task", "status", "1", "done", "--json"], ["task", "priority", "1", "low", "--human"], ["task", "assign", "1", "user-1", "--json"], ["task", "move", "1", "--to", P2, "--human"]],
  },
  // The read that confirms a write is the one that can fail after it landed.
  { name: "a read-back that fails after the write", failOn: "^GET /task/task-a1$", steps: [["task", "status", "1", "done", "--json"]] },
  { name: "task move", steps: [["task", "move", "1", "--to", P2, "--json"], ["task", "ls", "-p", P2, "--human"]] },
  // The destination as it was typed, so the line shows what was asked for rather
  // than the id behind it.
  { name: "task move human", steps: [["task", "move", "1", "--to", "BET", "--human"]] },
  { name: "task move without --to", steps: [["task", "move", "1", "--json"]] },
  // The server moves a task only within its own workspace, so a slug found only
  // in another one is said to be there rather than left as a bare 404.
  {
    name: "task move to a project in another workspace",
    seed: { projects: [...SEED.projects, { id: "proj-gamma", workspaceId: "ws-other", name: "Gamma", slug: "GAM" }] },
    steps: [["task", "move", "1", "--to", "GAM", "--human"], ["task", "move", "1", "--to", "proj-gamma", "--human"]],
  },
  // A slug in both workspaces is the one in the task's own, not several.
  {
    name: "task move to a slug another workspace also carries",
    seed: { projects: [...SEED.projects, { id: "proj-bet2", workspaceId: "ws-other", name: "Bet Two", slug: "BET" }] },
    steps: [["task", "move", "1", "--to", "BET", "--human"]],
  },
  { name: "task move to the project it is in", steps: [["task", "move", "1", "--to", "ALP", "--human"], ["task", "move", "1", "--to", P1, "--human"]] },
  // The task lives in the second workspace: the destination is looked up there,
  // and a slug only the first workspace carries is said to be elsewhere.
  {
    name: "task move from the second workspace",
    seed: {
      projects: [...SEED.projects, { id: "proj-gamma", workspaceId: "ws-other", name: "Gamma", slug: "GAM" }, { id: "proj-delta", workspaceId: "ws-other", name: "Delta", slug: "DEL" }],
      tasks: [...SEED.tasks, { id: "task-g1", projectId: "proj-gamma", title: "Gamma first" }],
    },
    steps: [["task", "move", "task-g1", "--to", "ALP", "--human"], ["task", "move", "task-g1", "--to", "DEL", "--human"]],
  },
  // A name two workspaces carry is the one in the task's own workspace.
  {
    name: "task move to a name another workspace also carries",
    seed: { projects: [...SEED.projects, { id: "proj-beta2", workspaceId: "ws-other", name: "Beta", slug: "BT2" }] },
    steps: [["task", "move", "1", "--to", "Beta", "--human"]],
  },
  // The task's own workspace cannot be listed, so its workspace is unknown and
  // the lookup stops rather than searching every workspace.
  {
    name: "task move when the task's workspace cannot be listed",
    failOn: "^GET /project$",
    failOnQuery: "workspaceId=ws-main",
    steps: [["task", "move", "1", "--to", "GAM", "--human"]],
  },
  // Another workspace that cannot be listed could not hold the destination, so
  // a miss is a miss and does not hedge about it.
  {
    name: "task move to a missing project while another workspace cannot be listed",
    failOn: "^GET /project$",
    failOnQuery: "workspaceId=ws-other",
    steps: [["task", "move", "1", "--to", "NOPE", "--human"]],
  },
  // The lookup is what fails, so the report carries both the server's answer and
  // the lookup's.
  { name: "task move when the lookup fails", failOn: "^GET /auth/organization/list$", steps: [["task", "move", "1", "--to", "BET", "--human"]] },
  // A 404 that does not say the project is missing is not a reason to look one up.
  {
    name: "task move refused with another 404",
    failOn: "^PUT /task/move/",
    failStatus: 404,
    failMessage: "Workspace not found",
    steps: [["task", "move", "1", "--to", "BET", "--human"]],
  },
  { name: "task due set and clear", steps: [["task", "due", "1", "2026-10-31", "--json"], ["task", "get", "1", "--json"], ["task", "due", "1", "--human"], ["task", "get", "1", "--json"]] },
  { name: "task due refuses a bad date", steps: [["task", "due", "1", "someday", "--json"], ["task", "due", "1", "", "--json"], ["task", "due", "1", " 2026-10-31 ", "--human"], ["task", "get", "1", "--human"]] },
  { name: "task bulk status", steps: [["task", "bulk", "1", "2", "ALP#1", "--status", "done", "--human"], ["task", "ls", "--all", "--json"]] },
  { name: "task bulk assign, due and clear", seed: { members: MEMBERS }, steps: [["task", "bulk", "1", "2", "--assign", "user-1", "--json"], ["task", "bulk", "1", "--due", "2026-12-01", "--json"], ["task", "bulk", "1", "2", "--unassign", "--human"], ["task", "bulk", "1", "--clear-due", "--json"], ["task", "ls", "--json"]] },
  { name: "task bulk takes exactly one change", steps: [["task", "bulk", "1", "--json"], ["task", "bulk", "1", "--status", "done", "--priority", "low", "--json"], ["task", "bulk", "1", "--priority", "soon", "--json"]] },
  { name: "task bulk delete needs --yes", steps: [["task", "bulk", "1", "2", "--delete", "--human"], ["task", "bulk", "1", "2", "--delete", "--yes", "--json"], ["task", "ls", "--all", "--json"]] },
  { name: "task bulk unknown task changes nothing", steps: [["task", "bulk", "1", "99", "--status", "done", "--json"]] },
  { name: "task bulk unknown label", steps: [["task", "bulk", "1", "--add-label", "lbl-x", "--json"]] },
  { name: "task bulk status across projects", steps: [["column", "create", "Waiting", "--json"], ["task", "bulk", "1", "BET#1", "--status", "waiting", "--json"], ["task", "bulk", "1", "BET#1", "--status", "done", "--human"], ["task", "ls", "--all", "-p", P2, "--json"]] },
  { name: "task bulk planned across projects", steps: [["task", "bulk", "1", "BET#1", "--status", "planned", "--human"]] },
  { name: "task bulk --yes is only for --delete", steps: [["task", "bulk", "1", "--status", "done", "--yes", "--json"]] },
  { name: "task bulk empty value", steps: [["task", "bulk", "1", "--status", "", "--json"], ["task", "bulk", "1", "--assign", " ", "--json"]] },
  { name: "task create assigns by name and me", seed: { members: MEMBERS }, steps: [["task", "create", "ByName", "--assignee", "ada", "--human"], ["task", "create", "ByMe", "--assignee", "me", "--human"], ["task", "ls", "--all", "--json"]] },
  { name: "task create with an unknown or empty assignee creates nothing", seed: { members: MEMBERS }, steps: [["task", "create", "Nobody's", "--assignee", "Nobody", "--json"], ["task", "create", "Blank", "--assignee", "  ", "--json"], ["task", "ls", "--all", "--json"]] },
  { name: "task bulk assigns by name and me", seed: { members: MEMBERS }, steps: [["task", "bulk", "1", "2", "--assign", "ada", "--json"], ["task", "bulk", "1", "--assign", "me", "--human"], ["task", "ls", "--all", "--json"]] },
  { name: "task bulk assigns only members", seed: { members: MEMBERS }, steps: [["task", "bulk", "1", "--assign", "user-nobody", "--json"]] },
  { name: "task bulk names a board three ways", steps: [["task", "bulk", "1", "ALP#2", "proj-alpha#3", "--priority", "low", "--json"]] },
  {
    // The human report names each board by its slug, the way the reference was
    // written, and a lone task reference is not a relation id.
    name: "task bulk names a board with a dash in the reference",
    steps: [
      ["task", "bulk", "1", "ALP-2", "BET-1", "--priority", "low", "--json"],
      ["task", "bulk", "ALP-2", "BET-1", "--priority", "high", "--human"],
      ["task", "bulk", "1", "NOPE-1", "--priority", "low", "--json"],
      ["task", "unlink", "BET-1", "--json"],
    ],
  },
  { name: "task get by a reference with a dash", steps: [["task", "get", "BET-1", "--json"], ["task", "get", "bet-1", "--json"], ["task", "get", "ALP-2", "--human"]] },
  { name: "task get by a reference with a dash that is not on the board", steps: [["task", "get", "NOPE-1", "--json"], ["task", "get", "ALP-99", "--json"]] },
  {
    // The last dash splits the reference, so a slug that holds dashes is a slug.
    name: "task get by a reference whose slug holds a dash",
    seed: {
      projects: [...SEED.projects, { id: "proj-kcli", workspaceId: WS, name: "Kaneo CLI", slug: "kaneo-cli" }],
      tasks: [...SEED.tasks, { id: "task-k1", projectId: "proj-kcli", title: "Dashed" }],
    },
    steps: [["task", "get", "kaneo-cli-1", "--json"], ["task", "get", "KANEO-CLI-1", "--human"]],
  },
  {
    // An active project answers before an archived namesake; two active ones
    // are the server's 409, shown as it wrote it.
    name: "task get by a reference with a dash two projects carry",
    seed: {
      projects: [
        ...SEED.projects,
        { id: "proj-alp-old", workspaceId: WS, name: "Alpha archived", slug: "ALP", archived: true },
        { id: "proj-dup1", workspaceId: WS, name: "Dup one", slug: "DUP" },
        { id: "proj-dup2", workspaceId: "ws-other", name: "Dup two", slug: "dup" },
      ],
      tasks: [
        ...SEED.tasks,
        { id: "task-old1", projectId: "proj-alp-old", title: "Archived namesake" },
        { id: "task-dup1", projectId: "proj-dup1", title: "First dup" },
        { id: "task-dup2", projectId: "proj-dup2", title: "Second dup" },
      ],
    },
    steps: [["task", "get", "ALP-1", "--json"], ["task", "get", "DUP-1", "--json"]],
  },
  // `-1` reads as the number -1, `BET--1` as the ticket id whose slug ends in a
  // dash, `BET-x` as an id, and `a?b-1` as a ticket id whose reserved character
  // has to reach the route percent-escaped.
  {
    name: "task get a negative number and other dash forms",
    steps: [
      ["task", "get", "--json", "--", "-1"],
      ["task", "get", "BET--1", "--json"],
      ["task", "get", "BET-x", "--json"],
      ["task", "get", "a?b-1", "--json"],
      ["task", "get", "BET-", "--json"],
    ],
  },
  { name: "task bulk delete counts each task once", steps: [["task", "bulk", "1", "ALP#1", "--delete", "--json"]] },
  ...both("task export", ["task", "export"]),
  { name: "task export piped", steps: [["task", "export"]] },
  { name: "task export keeps control characters", seed: { tasks: [{ id: "task-c1", projectId: P1, title: "odd\u0085title\u007f" }] }, steps: [["task", "export", "--human"], ["task", "export", "--json"]] },
  {
    name: "task import reports each task",
    files: {
      "tasks.json": JSON.stringify({
        project: { name: "Beta", slug: "BET", description: null, exportedAt: "2026-01-01T00:00:00.000Z" },
        tasks: [
          { title: "Imported", description: "from a file", status: "in-progress", priority: "high", dueDate: "2026-11-01T00:00:00.000Z", startDate: null, userId: null, labels: [{ name: "bug", color: "#f00" }] },
          { title: "Planned on purpose", status: "planned" },
          { title: "Stranger", status: "to-do", userId: "user-nobody" },
        ],
      }),
    },
    steps: [["task", "import", "tasks.json", "--human"], ["task", "import", "tasks.json", "--json"], ["task", "ls", "--json"]],
  },
  {
    name: "task import refuses what the server would replace",
    files: { "status.json": '[{"title":"ok","status":"to-do"},{"title":"Odd","status":"waiting"}]', "priority.json": '[{"title":"Odd","status":"to-do","priority":"soon"}]', "typed.json": '[{"title":"x","status":"to-do","priority":3}]', "null-title.json": '[{"title":null,"status":"to-do"}]', "typed-status.json": '[{"title":"x","status":3}]', "typed-description.json": '[{"title":"x","status":"to-do","description":3}]', "typed-start.json": '[{"title":"x","status":"to-do","startDate":3}]', "typed-due.json": '[{"title":"x","status":"to-do","dueDate":3}]', "typed-user.json": '[{"title":"x","status":"to-do","userId":3}]' },
    steps: [
      ["task", "import", "status.json", "--json"],
      ["task", "import", "priority.json", "--json"],
      ["task", "import", "typed.json", "--json"],
      ["task", "import", "null-title.json", "--json"],
      ["task", "import", "typed-status.json", "--json"],
      ["task", "import", "typed-description.json", "--json"],
      ["task", "import", "typed-start.json", "--json"],
      ["task", "import", "typed-due.json", "--json"],
      ["task", "import", "typed-user.json", "--json"],
      ["task", "ls", "--json"],
    ],
  },
  { name: "task import takes empty and null dates", stdin: '[{"title":"No dates","status":"to-do","dueDate":"","startDate":null,"userId":null}]', steps: [["task", "import", "-", "--json"]] },
  { name: "task import from stdin", stdin: '[{"title":"From stdin","status":"to-do"}]', steps: [["task", "import", "-", "--human"], ["task", "ls", "--json"]] },
  { name: "task import needs a key before reading", env: { KANEO_API_KEY: "" }, stdin: "[]", steps: [["task", "import", "-", "--json"]] },
  {
    name: "task import refuses a bad file",
    files: {
      "broken.json": "{",
      "empty.json": '{"tasks":[]}',
      "untitled.json": '[{"status":"to-do"}]',
      "blank-title.json": '[{"title":" ","status":"to-do"}]',
      "no-status.json": '[{"title":"x"}]',
      "blank-status.json": '[{"title":"x","status":" "}]',
      "second-bad.json": '[{"title":"ok","status":"to-do"},{"title":"y","status":"to-do","dueDate":"someday"}]',
      "bad-start.json": '[{"title":"y","status":"to-do","startDate":"soon"}]',
      "object.json": '{"title":"x"}',
    },
    steps: [
      ["task", "import", "missing.json", "--json"],
      ["task", "import", "broken.json", "--json"],
      ["task", "import", "empty.json", "--json"],
      ["task", "import", "untitled.json", "--json"],
      ["task", "import", "blank-title.json", "--json"],
      ["task", "import", "no-status.json", "--json"],
      ["task", "import", "blank-status.json", "--json"],
      ["task", "import", "second-bad.json", "--json"],
      ["task", "import", "bad-start.json", "--json"],
      ["task", "import", ".", "--json"],
      ["task", "import", "object.json", "--json"],
    ],
  },
  { name: "task rm needs --yes", steps: [["task", "rm", "1", "--human"], ["task", "rm", "1", "--yes", "--json"], ["task", "ls", "--all", "--json"]] },
  { name: "task link and links", steps: [["task", "link", "1", "2", "--type", "subtask", "--json"], ["task", "links", "2", "--human"], ["task", "link", "1", "3", "--type", "blocks", "--human"], ["task", "links", "1", "--json"], ["task", "links", "1", "--human"], ["task", "get", "1", "--human"], ["task", "get", "1", "--json"], ["task", "links", "3", "--human"], ["task", "link", "2", "3", "--type", "subtask", "--human"]] },
  { name: "task links name a task on another board", steps: [["task", "link", "1", "BET#1", "--type", "blocks", "--json"], ["task", "link", "2", "1", "--type", "related", "--json"], ["task", "links", "1", "--human"], ["task", "get", "1", "--human"], ["task", "links", "BET#1", "--human"], ["task", "links", "BET#1", "--json"]] },
  { name: "task links name a task on a board with no slug by its id", seed: { projects: [...SEED.projects, { id: "proj-noslug", workspaceId: WS, name: "No slug", slug: "" }] }, extraTasks: [{ id: "task-n1", projectId: "proj-noslug", title: "Unslugged" }], steps: [["task", "link", "1", "task-n1", "--type", "related", "--json"], ["task", "links", "1", "--human"]] },
  { name: "task link unknown type", steps: [["task", "link", "1", "2", "--type", "blocker", "--json"], ["task", "unlink", "1", "2", "--type", "blocker", "--json"]] },
  { name: "task link without --type", steps: [["task", "link", "1", "2", "--json"], ["task", "links", "1", "--json"]] },
  { name: "task unlink by tasks", steps: [["task", "link", "1", "2", "--type", "related", "--json"], ["task", "unlink", "2", "1", "--human"], ["task", "links", "1", "--json"], ["task", "link", "1", "2", "--type", "blocks", "--json"], ["task", "unlink", "2", "1", "--json"]] },
  { name: "task unlink by relation id", steps: [["task", "link", "1", "2", "--type", "blocks", "--json"], ["task", "unlink", "rel0002", "--type", "blocks", "--json"], ["task", "unlink", "rel0002", "--human"], ["task", "links", "1", "--json"]] },
  { name: "task unlink one task number", steps: [["task", "unlink", "1", "--json"], ["task", "unlink", "#1", "--json"]] },
  { name: "task unlink ambiguous", steps: [["task", "link", "1", "2", "--type", "related", "--json"], ["task", "link", "1", "2", "--type", "blocks", "--json"], ["task", "unlink", "1", "2", "--json"], ["task", "unlink", "1", "2", "--type", "blocks", "--human"], ["task", "links", "1", "--human"]] },
  { name: "task unlink nothing to unlink", steps: [["task", "unlink", "1", "2", "--json"]] },
  { name: "task external-links", seed: { externalLinks: [{ taskId: "task-a1", url: "https://example.com/spec", title: "Spec" }, { taskId: "task-a1", url: "https://github.com/o/r/pull/7", title: null, resourceType: "pull_request", externalId: "7", integration: { id: "int-1", type: "github" } }] }, steps: [["task", "external-links", "1", "--json"], ["task", "external-links", "1", "--human"], ["task", "external-links", "2", "--json"], ["task", "external-links", "2", "--human"], ["task", "external-links", "99", "--json"]] },
  // --add and --rm mutate and then list, so the answer shows the links as the
  // server now holds them; an integration's link is not the endpoint's to
  // remove, and neither is an id no link has.
  {
    name: "task external-links add and remove",
    seed: { externalLinks: [{ taskId: "task-a1", url: "https://example.com/spec", title: "Spec" }, { taskId: "task-a1", url: "https://github.com/o/r/pull/7", title: null, resourceType: "pull_request", externalId: "7", integration: { id: "int-1", type: "github" } }] },
    steps: [
      ["task", "external-links", "1", "--add", "https://example.com/notes", "--title", "Notes", "--json"],
      ["task", "external-links", "1", "--add", "https://example.com/plain", "--human"],
      ["task", "external-links", "1", "--rm", "link0004", "--json"],
      ["task", "external-links", "1", "--rm", "link0003", "--json"],
      ["task", "external-links", "1", "--rm", "link0009", "--json"],
      ["task", "external-links", "1", "--human"],
    ],
  },
  // Refused before any request: both mutations at once, a title with no --add,
  // a value that is no http(s) URL, and a title past the server's 200.
  {
    name: "task external-links refuses bad input",
    steps: [
      ["task", "external-links", "1", "--add", "https://example.com/x", "--rm", "link0002", "--json"],
      ["task", "external-links", "1", "--title", "Notes", "--json"],
      ["task", "external-links", "1", "--add", "ftp://example.com/x", "--json"],
      ["task", "external-links", "1", "--add", "not a url", "--json"],
      ["task", "external-links", "1", "--add", "https://example.com/x", "--title", "t".repeat(201), "--json"],
      ["task", "external-links", "1", "--add", "", "--json"],
      ["task", "external-links", "1", "--rm", " ", "--json"],
      ["task", "external-links", "99", "--add", "https://example.com/x", "--json"],
    ],
  },
  // The mutation lands and the list that follows it fails: the error names
  // the write that happened, as taskAfterWrite names its own, so the caller
  // does not retry a write that already landed.
  {
    name: "task external-links names a landed write when the list fails",
    seed: { externalLinks: [{ taskId: "task-a1", url: "https://example.com/spec", title: "Spec" }] },
    failOn: "^GET /external-link/",
    steps: [
      ["task", "external-links", "1", "--add", "https://example.com/notes", "--json"],
      ["task", "external-links", "1", "--rm", "link0002", "--json"],
    ],
  },
  // The description page route: a short description is one page, a long one
  // pages at 32 Ki characters with the version the first page answered, and a
  // task the board does not have is the server's 404.
  {
    name: "task describe",
    extraTasks: [
      { id: "task-a4", projectId: P1, title: "Paged story", description: "x".repeat(32769) },
      { id: "task-a5", projectId: P1, title: "Kana story", description: "あ".repeat(33_000) },
    ],
    steps: [
      ["task", "describe", "1", "--human"],
      ["task", "describe", "1", "--json"],
      ["task", "describe", "4", "--json"],
      ["task", "describe", "5", "--json"],
      ["task", "describe", "99", "--json"],
    ],
  },
  // --description filters on the descriptions the listing carries and asks the
  // server about the ones it deferred, both case-insensitively.
  {
    name: "task list by description",
    extraTasks: [
      { id: "task-a4", projectId: P1, title: "Deferred needle", description: `${"x".repeat(65_537)}Needle in the deferred text` },
      { id: "task-a5", projectId: P1, title: "Deferred other", description: `${"y".repeat(65_537)}nothing here` },
      { id: "task-a6", projectId: P1, title: "Plain needle", description: "a Needle in plain text" },
    ],
    steps: [
      ["task", "ls", "--description", "needle", "--json"],
      ["task", "ls", "--description", "NEEDLE", "--human"],
      ["task", "ls", "--description", "missing", "--json"],
      ["task", "ls", "--description", "needle", "--status", "to-do", "--json"],
    ],
  },
  // More deferred matches than the server's hundred a page: the cursor pages
  // the rest.
  {
    name: "task list by description pages the deferred matches",
    extraTasks: Array.from({ length: 105 }, (_, i) => ({
      id: `task-d${String(i).padStart(3, "0")}`,
      projectId: P1,
      title: `Deferred ${i}`,
      description: `${"x".repeat(65_536)}needle ${i}`,
    })),
    steps: [["task", "ls", "--description", "needle", "--json"]],
  },
  // An empty or overlong query and --mine are refused before any request; an
  // empty query --mine is passed still hits the empty check rather than
  // being ignored.
  {
    name: "task list by description refuses bad input",
    steps: [
      ["task", "ls", "--description", "", "--json"],
      ["task", "ls", "--description", "  ", "--json"],
      ["task", "ls", "--description", "x".repeat(257), "--json"],
      ["task", "ls", "--mine", "--description", "x", "--json"],
      ["task", "ls", "--mine", "--description", "", "--json"],
      ["task", "ls", "--json"],
    ],
  },
  // With nothing deferred there is nothing for the server to be asked about:
  // the listing's requests show no description-matches call.
  {
    name: "task list by description with nothing deferred",
    steps: [
      ["task", "ls", "--description", "multi", "--json"],
      ["task", "ls", "--description", "missing", "--human"],
    ],
  },
  // The copy keeps the source's fields, its parent link and its label; the
  // listing shows what the copy holds.
  {
    name: "task duplicate",
    seed: { labels: [{ taskId: "task-a1", name: "bug", color: "red" }] },
    steps: [
      ["task", "link", "2", "1", "--type", "subtask", "--json"],
      ["task", "duplicate", "1", "--json"],
      ["task", "get", "4", "--json"],
      ["task", "links", "4", "--human"],
      ["task", "duplicate", "2", "--title", "Ship it, again", "--human"],
      ["task", "ls", "--all", "--json"],
    ],
  },
  // --to resolves the destination before the copy exists and moves the copy
  // after; a destination that is the source's own project is refused before
  // the copy is made, since the move would fail and leave the copy behind.
  {
    name: "task duplicate to another project",
    steps: [
      ["task", "duplicate", "1", "--to", "Beta", "--json"],
      ["task", "duplicate", "2", "--to", "proj-beta", "--title", "Moved copy", "--human"],
      ["task", "duplicate", "1", "--to", "ALP", "--json"],
      ["task", "ls", "-p", "Beta", "--all", "--json"],
      ["task", "ls", "--all", "--json"],
    ],
  },
  // --to into another workspace is refused before the copy exists: the
  // server moves a task only within its own workspace, and a copy the move
  // then refused would be left behind. The listing after shows nothing was
  // created.
  {
    name: "task duplicate to a project in another workspace",
    seed: { projects: [...SEED.projects, { id: "proj-gamma", workspaceId: "ws-other", name: "Gamma", slug: "GAM" }] },
    steps: [
      ["task", "duplicate", "1", "--to", "GAM", "--json"],
      ["task", "duplicate", "1", "--to", "proj-gamma", "--json"],
      ["task", "ls", "--all", "--json"],
    ],
  },
  // The move after the copy is a write like any other: a 200 that did not
  // take is caught by the read-back, as `task move` checks its own.
  {
    name: "task duplicate move the server did not keep",
    writesNotKept: true,
    steps: [["task", "duplicate", "1", "--to", P2, "--json"]],
  },
  // A blank --title or --to and an unknown task are refused; a --to that
  // names no project fails before the copy is made.
  {
    name: "task duplicate refuses bad input",
    steps: [
      ["task", "duplicate", "1", "--title", "", "--json"],
      ["task", "duplicate", "1", "--title", " ", "--json"],
      ["task", "duplicate", "1", "--to", "", "--json"],
      ["task", "duplicate", "99", "--json"],
      ["task", "duplicate", "BET#1", "--to", "NoSuch", "--json"],
      ["task", "ls", "--all", "--json"],
    ],
  },
  // The task-scoped image upload: stage, PUT the bytes to the presigned URL,
  // finalize, and the answer is the asset's URL. --surface picks the folder
  // the object key is issued under.
  {
    name: "task upload",
    files: { "pixel.png": "fake png bytes" },
    steps: [
      ["task", "upload", "1", "pixel.png", "--json"],
      ["task", "upload", "1", "pixel.png", "--surface", "comment", "--human"],
      ["task", "upload", "1", "pixel.png", "--surface", "bogus", "--json"],
      ["task", "upload", "99", "pixel.png", "--json"],
      ["task", "upload", "1", "missing.png", "--json"],
    ],
  },
  // An empty file is refused before any request, and a storage that refuses
  // the bytes fails the upload after the stage was issued, before finalize.
  {
    name: "task upload refuses an empty file",
    files: { "empty.png": "" },
    steps: [["task", "upload", "1", "empty.png", "--json"], ["task", "ls", "--all", "--json"]],
  },
  {
    name: "task upload storage refuses the bytes",
    files: { "pixel.png": "fake png bytes" },
    failOn: "^PUT /uploads/",
    steps: [["task", "upload", "1", "pixel.png", "--json"], ["task", "ls", "--all", "--json"]],
  },
  // The stage and the finalize are /api routes, so failOn reaches them as it
  // does every other write: the stage failing means no bytes are PUT, and the
  // finalize failing means the stored object is never recorded as an asset.
  {
    name: "task upload stage is refused",
    files: { "pixel.png": "fake png bytes" },
    failOn: "^PUT /task/image-upload/",
    steps: [["task", "upload", "1", "pixel.png", "--json"], ["task", "ls", "--all", "--json"]],
  },
  {
    name: "task upload finalize is refused",
    files: { "pixel.png": "fake png bytes" },
    failOn: "^POST /task/image-upload/",
    steps: [["task", "upload", "1", "pixel.png", "--json"], ["task", "ls", "--all", "--json"]],
  },

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
  // halt_error(n) is jq's own way to pick an exit status, and it survives.
  { name: "jq halt_error keeps its exit code", steps: [["task", "get", "1", "--jq", '"boom" | halt_error(2)']] },
  // debug's line is jq's stderr text, not part of the failure message.
  { name: "jq separates debug from a failure", steps: [["task", "get", "1", "--jq", ". | debug | .title | tonumber"]] },
  // --timeout bounds the filter the way it bounds a request: an expression
  // that never finishes is killed rather than holding the command open.
  { name: "jq timeout bounds the filter", steps: [["task", "get", "1", "--jq", "def f: f; f", "--timeout", "1s"]] },
  { name: "jq leaves stdout empty on a command error", steps: [["task", "get", "99", "--jq", ".number"]] },
  // Refused while parsing, before the filter exists, and still kept off stdout.
  { name: "jq leaves stdout empty on a usage error", steps: [["task", "get", "--jq", ".number"], ["task", "get", "1", "--bogus", "--jq=.number"]] },
  { name: "jq keeps empty strings", steps: [["task", "ls", "--all", "--jq", ".[] | .description"]] },
  // Fail-open hides an unreachable server, not a broken expression.
  { name: "jq fails a fail-open command", env: { KANEO_SESSION_ID: "sess-test" }, steps: [["session", "attach", "1", "--jq", ".nope | tonumber"]] },
  { name: "jq empty means no filter", steps: [["task", "get", "1", "--jq", "", "--json"]] },
  // The parser uses the last --jq, so a refused line is judged by that one: an
  // empty last expression leaves the error where it would have been without the
  // flag, a non-empty one keeps stdout empty.
  { name: "jq last expression wins on a usage error", steps: [["task", "get", "--jq", "", "--jq", ".number"], ["task", "get", "--jq", ".x", "--jq", ""]] },
  // The value of a string flag is not a flag, whatever it looks like.
  { name: "jq as the value of another flag", steps: [["task", "create", "--description", "--jq"], ["task", "create", "--description", "--", "--jq", ".x"]] },
  // Everything after "--" is an argument.
  { name: "jq after the end of the flags", steps: [["task", "get", "--", "--jq", ".x"]] },
  { name: "jq empty on a usage error", steps: [["task", "get", "--jq", ""], ["task", "get", "--jq="]] },
  ...["--jq=.serverOperations", "--jq=.missing | tonumber"].map((flag, i): Scenario => ({
    name: `api-check with a jq expression (${i === 0 ? "picks" : "fails"})`,
    steps: [["api-check", flag]],
  })),
  {
    name: "api-check missing operation with a jq expression that fails",
    specWithoutOperation: true,
    steps: [["api-check", "--jq=.covered | tonumber"], ["api-check", "--jq", ".missing | length"]],
  },

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

  { name: "label create with --name", steps: [["label", "create", "--name", " flagged one ", "--color", "red", "--json"], ["label", "ls", "--human"]] },
  { name: "label create with --name and words", steps: [["label", "create", "Words", "--name", "Flagged", "--json"], ["label", "ls", "--human"]] },
  { name: "label create with no name", steps: [["label", "create", "--json"]] },
  { name: "label create with an empty --name", steps: [["label", "create", "--name", " ", "--json"], ["label", "create", "--name", "", "--json"], ["label", "create", "Words", "--name", "", "--json"], ["label", "ls", "--human"]] },
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
    name: "label rename onto a task copy of the new name",
    extraTasks: [
      { id: "task-a4", projectId: P1, title: "Needs triage" },
      { id: "task-a5", projectId: P1, title: "Only old" },
      { id: "task-a6", projectId: P1, title: "Both too" },
    ],
    seed: {
      labels: [
        { taskId: "task-a4", name: "bug" },
        { taskId: "task-a4", name: "defect" },
        { taskId: "task-a5", name: "bug" },
        { taskId: "task-a1", name: "defect" },
        { taskId: "task-a6", name: "bug" },
        { taskId: "task-a6", name: "defect" },
      ],
    },
    steps: [
      ["label", "create", "bug", "--json"],
      ["label", "update", "bug", "--name", " defect ", "--human"],
      ["label", "update", "bug", "--color", "red", "--human"],
      ["label", "update", "bug", "--name", "bug", "--human"],
      ["label", "update", "bug", "--name", "other", "--human"],
      ["label", "ls", "--human"],
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
    // A seeded feed resolves its label names to workspace definitions the way
    // create does, so "bug" is a definition while "solo" exists only as a copy
    // on task-cal2 until `feed create solo` materializes one. "doomed" exists
    // as a live copy on task-cal3 and as a workspace definition whose deletion
    // has started: the feed form drops the whole name, the way the task label
    // picker does, so create refuses it before the server is asked.
    name: "feed create, list, get and rm",
    seed: {
      labels: [
        { taskId: "task-cal", name: "bug" },
        { taskId: "task-cal2", name: "solo" },
        { taskId: "task-cal3", name: "doomed" },
      ],
      deletingLabels: [{ workspaceId: WS, name: "doomed" }],
      calendarFeeds: [{ projectId: P1, labels: ["bug"] }],
    },
    extraTasks: [
      { id: "task-cal", projectId: P1, title: "Ship the feed", description: "line one\nline two", startDate: "2026-01-05T00:00:00Z", dueDate: "2026-01-07T00:00:00Z" },
      { id: "task-cal2", projectId: P1, title: "Solo dated", startDate: "2026-01-09T00:00:00Z" },
      { id: "task-cal3", projectId: P1, title: "Undated" },
    ],
    steps: [
      ["feed", "ls", "--json"],
      ["feed", "ls", "--human"],
      ["feed", "create", "bug", "--time-zone", "Europe/Berlin", "--json"],
      // Human mode, so the line has to name the definition the create
      // materialized for "solo" rather than the copy it was resolved from.
      ["feed", "create", "solo", "--human"],
      ["feed", "create", "bug", "bug", "--human"],
      ["feed", "create", "nope", "--json"],
      ["feed", "create", "doomed", "--json"],
      ["feed", "create", "bug", "--time-zone", "Nowhere/Special", "--json"],
      ["feed", "get", feedToken(1)],
      // The token is trimmed like every other argument: the padding is not
      // part of it, and the document still arrives.
      ["feed", "get", ` ${feedToken(1)} `],
      // The document is not JSON, so the output flags are refused rather than
      // answered with text they cannot read.
      ["feed", "get", feedToken(3), "--json"],
      ["feed", "get", feedToken(3), "--jq", "."],
      ["feed", "get", "not-a-token"],
      ["feed", "get", feedToken(99)],
      ["feed", "rm", "feed0001", "--json"],
      ["feed", "rm", feedToken(2), "--yes", "--json"],
      ["feed", "rm", "feed9999", "--yes", "--json"],
      ["feed", "ls", "-p", "BET", "--json"],
      ["feed", "ls", "--human"],
      ["feed", "rm", " feed0004 ", "--yes", "--json"],
    ],
  },
  {
    // The listing decorates label ids with names only in human mode, so a
    // missing workspace costs the names, not the feeds; create needs the
    // workspace's labels, so it is refused outright.
    name: "feed without a workspace",
    env: { KANEO_WORKSPACE: "" },
    seed: { calendarFeeds: [{ projectId: P1, labels: ["bug"] }] },
    steps: [["feed", "ls", "--human"], ["feed", "ls", "--json"], ["feed", "create", "bug", "--json"]],
  },
  {
    // -w takes an id, a slug or a name, and the feed commands resolve it to the
    // workspace's id the way every other workspace-scoped command does before
    // asking for its labels. "main" is ws-main's slug: sent raw it would name
    // no workspace's labels at all.
    name: "feed commands resolve a workspace slug",
    env: { KANEO_WORKSPACE: "main" },
    seed: { calendarFeeds: [{ projectId: P1, labels: ["bug"] }] },
    steps: [
      ["feed", "ls", "--human"],
      ["feed", "create", "bug", "--json"],
      ["feed", "ls", "--human"],
    ],
  },
  {
    // The label names are decoration read after the write: when that read
    // fails the created feed — and its subscribe link — is still printed, with
    // the reason on stderr, rather than the command failing as if nothing was
    // made. The first labels read, create's own options, still succeeds; every
    // read after it fails, so `feed ls` degrades the same way.
    name: "feed create prints the feed when label names cannot be read",
    failOn: "^GET /label/workspace/",
    failOnSkip: 1,
    seed: { calendarFeeds: [{ projectId: P1, labels: ["bug"] }] },
    steps: [["feed", "create", "bug", "--human"], ["feed", "ls", "--human"]],
  },
  { name: "comment add from stdin", stdin: "multi\nline $comment\n", steps: [["comment", "add", "1", "-", "--json"], ["comment", "ls", "1", "--json"]] },
  { name: "comment add from a file", files: { "c.md": "from a file\n" }, steps: [["comment", "add", "1", "--file", "c.md", "--human"]] },
  { name: "comment add with text and a file", files: { "c.md": "x" }, steps: [["comment", "add", "1", "hi", "--file", "c.md", "--json"]] },
  { name: "comment add empty stdin", stdin: "", steps: [["comment", "add", "1", "-", "--json"]] },
  { name: "comment add nothing", steps: [["comment", "add", "1", "--json"]] },
  { name: "comment add blank", steps: [["comment", "add", "1", "   ", "--json"]] },

  ...both("notification list", ["notification", "list"]),
  { name: "notification list unread", steps: [["notification", "ls", "--unread", "--json"], ["notification", "ls", "--unread", "--human"]] },
  {
    name: "notification read",
    steps: [
      ["notification", "read", N2, N3, "--json"],
      ["notification", "read", N1, "nope", "--json"],
      ["notification", "read", "--human"],
      ["notification", "read", N1, "--all"],
      ["notification", "read", "a/b?#c", "--json"],
      ["notification", "ls", "--json"],
    ],
  },
  { name: "notification read all", steps: [["notification", "read", "--all", "--human"], ["notification", "ls", "--json"]] },
  { name: "notification clear needs --yes", steps: [["notification", "clear", "--human"], ["notification", "clear", "--yes", "--json"], ["notification", "ls", "--json"]] },
  {
    name: "notification create",
    steps: [
      ["notification", "create", "build", "is", "green", "--title", "CI", "--resource-type", "task", "--resource-id", "task-a1", "--json"],
      ["notification", "create", "plain", "--human"],
      ["notification", "create", "x", "--resource-type", "task", "--json"],
      ["notification", "create", "x", "--resource-type", "banana", "--resource-id", "b1", "--json"],
      ["notification", "create", "unreachable", "--resource-type", "task", "--resource-id", "task-nobody", "--human"],
      ["notification", "preferences", "set", "--task-comment=false", "--json"],
      ["notification", "create", "muted", "--type", "task_mention", "--human"],
      ["notification", "create", "muted", "--type", "task_comment", "--json"],
      ["notification", "ls", "--human"],
    ],
  },
  ...both("notification preferences get", ["notification", "preferences", "get"]),
  {
    name: "notification preferences set",
    steps: [
      ["notification", "prefs", "set", "--ntfy", "--ntfy-server", "https://ntfy.example", "--ntfy-topic", "kaneo", "--ntfy-token", "tk_abcdef123456", "--email", "--reminder-lead", "2h", "--json"],
      ["notification", "prefs", "set", "--ntfy-token", "", "--human"],
      ["notification", "prefs", "set", "--ntfy-server", "", "--json"],
      ["notification", "prefs", "set", "--human"],
      ["notification", "prefs", "set", "--reminder-lead", "90s", "--json"],
      ["notification", "prefs", "set", "--reminder-lead", "1m", "--json"],
    ],
  },
  {
    name: "notification preferences set ntfy token from stdin",
    stdin: "tk_from_stdin_77\n",
    steps: [
      ["notification", "prefs", "set", "--ntfy", "--ntfy-server", "https://ntfy.example", "--ntfy-topic", "kaneo", "--ntfy-token", "-", "--json"],
    ],
  },
  {
    name: "notification preferences set webhook secret from stdin",
    stdin: "whsec_from_stdin_88\r\n",
    steps: [["notification", "prefs", "set", "--webhook-url", "https://example.com/hook", "--webhook-secret", "-", "--json"]],
  },
  { name: "notification preferences set gotify token from stdin", stdin: " gt_from_stdin_99 \n", steps: [["notification", "prefs", "set", "--gotify-token", "-", "--human"]] },
  { name: "notification preferences set empty stdin", stdin: "\n", steps: [["notification", "prefs", "set", "--ntfy-token", "-", "--json"]] },
  {
    name: "notification preferences set topic dash stays literal",
    stdin: "tk_unused\n",
    steps: [["notification", "prefs", "set", "--ntfy-topic", "-", "--json"]],
  },
  { name: "notification preferences set truly empty stdin", stdin: "", steps: [["notification", "prefs", "set", "--ntfy-token", "-", "--json"]] },
  {
    name: "notification preferences set drops one line ending only",
    stdin: "whsec_two\n\n",
    steps: [["notification", "prefs", "set", "--webhook-url", "https://example.com/hook", "--webhook-secret", "-", "--json"]],
  },
  {
    name: "notification preferences set keeps whitespace-only stdin",
    stdin: "  ",
    steps: [["notification", "prefs", "set", "--webhook-url", "https://example.com/hook", "--webhook-secret", "-", "--json"]],
  },
  // Empty stdin would be its own error if it were read first.
  {
    name: "notification preferences set two secrets refused before stdin is read",
    stdin: "",
    steps: [["notification", "prefs", "set", "--gotify-token", "-", "--webhook-secret", "-", "--json"]],
  },
  {
    name: "notification preferences set two secrets from stdin",
    stdin: "tk_one\n",
    steps: [["notification", "prefs", "set", "--ntfy-token", "-", "--webhook-secret", "-", "--json"]],
  },
  {
    name: "notification preferences set one secret from stdin beside another",
    stdin: "tk_one\n",
    steps: [["notification", "prefs", "set", "--ntfy", "--ntfy-server", "https://ntfy.example", "--ntfy-topic", "kaneo", "--ntfy-token", "-", "--webhook-url", "https://example.com/hook", "--webhook-secret", "", "--json"]],
  },
  {
    name: "notification preferences carry into rules",
    steps: [
      ["notification", "prefs", "set", "--email", "--human"],
      ["notification", "prefs", "ws", "set", WS, "--active", "--human"],
      ["notification", "prefs", "ws", "set", "ws-other", "--active=false", "--human"],
      ["notification", "prefs", "set", "--webhook", "--webhook-url", "https://example.com/hook", "--human"],
      ["notification", "prefs", "set", "--email=false", "--human"],
      // The inactive rule kept email, which can no longer deliver.
      ["notification", "prefs", "ws", "set", "ws-other", "--active", "--human"],
      ["notification", "prefs", "ws", "set", WS, "--email", "--json"],
      // A rule with no channel on is not reached; an active one with a channel is,
      // but only for a channel that was off before.
      ["notification", "prefs", "ws", "set", "ws-other", "--webhook=false", "--human"],
      ["notification", "prefs", "set", "--email", "--human"],
      ["notification", "prefs", "ws", "set", WS, "--email=false", "--human"],
      ["notification", "prefs", "set", "--email", "--human"],
      ["notification", "prefs", "set", "--gotify-token", "", "--json"],
    ],
  },
  {
    name: "notification preferences workspace rule",
    steps: [
      ["notification", "prefs", "ws", "set", WS, "--webhook", "--json"],
      ["notification", "prefs", "set", "--email", "--human"],
      ["notification", "prefs", "ws", "set", WS, "--projects", P1, "--json"],
      ["notification", "prefs", "ws", "set", WS, "--email=false", "--human"],
      ["notification", "prefs", "ws", "set", WS, "--email", "--active=false", "--human"],
      ["notification", "prefs", "ws", "set", WS, "--projects", `${P1}, ${P2}`, "--human"],
      ["notification", "prefs", "ws", "set", WS, "--human"],
      ["notification", "prefs", "ws", "set", WS, "--projects", "proj-nowhere", "--human"],
      ["notification", "prefs", "ws", "set", WS, "--active", "--projects", "", "--human"],
      ["notification", "prefs", "set", "--email=false", "--human"],
      ["notification", "prefs", "ws", "set", "ws-nobody", "--active=false", "--json"],
      ["notification", "prefs", "ws", "rm", "a/b?#c", "--json"],
      ["notification", "prefs", "ws", "rm", WS, "--json"],
      ["notification", "prefs", "ws", "rm", WS, "--human"],
    ],
  },

  {
    name: "time add, list, update, stop",
    steps: [
      ["time", "add", "1", "--start", "2026-01-01T09:00:00Z", "--end", "2026-01-01T10:30:00Z", "-d", "review", "--json"],
      ["time", "start", "1", "--start", "2026-01-01T08:00:00Z", "--human"],
      ["time", "ls", "1", "--human"],
      ["time", "list", "1", "--json"],
      ["time", "update", "time0003", "--end", "2026-01-01T08:45:00Z", "-d", "triage", "--human"],
      ["time", "update", "time0002", "--end", "2026-01-01T11:00:00Z", "--json"],
      ["time", "update", "time0002", "-d", "", "--json"],
      ["time", "update", "time0002", "--human"],
      ["time", "update", "time0002", "--start", "2026-01-01T12:00:00Z", "--human"],
      ["time", "update", "time0002", "--end", "", "--human"],
      ["time", "get", "time0003", "--json"],
      ["time", "add", "1", "--start", "2026-01-01T10:00:00Z", "--end", "2026-01-01T09:00:00Z", "--human"],
      ["time", "add", "1", "--end", "2026-01-01T09:00:00Z", "--human"],
      ["time", "add", "1", "--start", "2026-01-01T09:00", "--human"],
      ["time", "add", "1", "--start", "2026-02-30T09:00:00Z", "--json"],
      ["time", "add", "1", "--start", "", "--human"],
      ["time", "add", "1", "--start", "2026-01-01T09:00:00Z", "--end", "2026-01-01T10:00", "--human"],
      ["time", "update", "time0002", "--start", "2026-01-01T09:00", "--human"],
      ["time", "start", "1", "--start", "2026-01-01T10:00:00+09:00", "--human"],
      ["time", "stop", "time0002", "--human"],
      ["time", "stop", "nope", "--human"],
      ["time", "get", "nope", "--human"],
    ],
  },

  {
    name: "session attach, next, close",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [["session", "attach", "1", "write", "tests", "--strict"], ["session", "next", "ship", "--strict"], ["board", "--json"], ["board", "--human"], ["session", "close", "--strict"], ["board", "--json"]],
  },
  // task get names the sessions holding the task, as board does: the running one
  // is listed with its newest marker, the one that closed and the human comment
  // are not, and a task nobody holds shows an empty list.
  {
    name: "task get names the sessions holding it",
    seed: {
      comments: [
        { taskId: "task-a1", content: "<!-- kn:session id=sess-old host=h1 cwd=/work/old branch=b1 state=running enc=1 -->\nfirst step" },
        { taskId: "task-a1", content: "<!-- kn:session id=sess-old host=h1 cwd=/work/old branch=b1 state=closed enc=1 -->" },
        { taskId: "task-a1", content: "<!-- kn:session id=sess-live-0123 host=h2 cwd=/work/live%20dir branch=b2 state=running enc=1 -->\nwrite tests" },
        { taskId: "task-a1", content: "<!-- kn:session id=sess-bare host=h3 cwd=/work/bare branch=b3 state=running enc=1 -->" },
        { taskId: "task-a1", content: "a human comment" },
      ],
    },
    steps: [["task", "get", "1", "--json"], ["task", "get", "1", "--human"], ["task", "get", "2", "--json"]],
  },
  // A task whose comments cannot be read is not reported as held by nobody.
  { name: "task get stops when the comments cannot be read", failOn: "^GET /comment/task-a1$", steps: [["task", "get", "1", "--json"], ["task", "get", "1", "--human"]] },
  { name: "session attach fails quietly", env: { KANEO_SESSION_ID: "sess-test" }, steps: [["session", "attach", "99"]] },
  { name: "session attach strict reports", env: { KANEO_SESSION_ID: "sess-test" }, steps: [["session", "attach", "99", "--strict"]] },
  // The server takes the marker and its listing does not hold it. Reported without
  // --strict, like the local record that could not be written: the session has a
  // marker on a board nothing here can read.
  {
    name: "marker not among the comments",
    env: { KANEO_SESSION_ID: "sess-lost" },
    dropCommentsMatching: "kn:session",
    steps: [["session", "attach", "1"]],
  },
  // The marker is posted and the listing that would confirm it fails: still a
  // failure without --strict, since the marker is on the server either way.
  {
    name: "marker that could not be confirmed",
    env: { KANEO_SESSION_ID: "sess-lost" },
    failOn: "^GET /comment/task-a1$",
    steps: [["session", "attach", "1"]],
  },
  // A reply with no id has nothing to look for, which is reported as that rather
  // than as a marker missing from the listing.
  {
    name: "marker reply without an id",
    env: { KANEO_SESSION_ID: "sess-lost" },
    commentReplyWithoutId: true,
    steps: [["session", "attach", "1"]],
  },
  // `session next` posts a marker too, so it confirms it the same way.
  {
    name: "session next marker not among the comments",
    env: { KANEO_SESSION_ID: "sess-lost" },
    dropCommentsMatching: "kn:session",
    steps: [["session", "next", "--task", "1", "step"]],
  },
  // The same listing failing is not a failure for `session next`: it keeps no
  // record of the marker, so the write that landed is the whole of what it did.
  {
    name: "session next when the listing fails",
    env: { KANEO_SESSION_ID: "sess-lost" },
    failOn: "^GET /comment/task-a1$",
    steps: [["session", "next", "--task", "1", "step"]],
  },
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
  // The dash form the server writes a task as names the held task too, so the
  // close takes it without a lookup of its own.
  {
    name: "session close --task names the held task by its ticket id",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [["session", "attach", "1", "--strict"], ["session", "close", "--task", "ALP-1", "--strict"], ["session", "status", "--json"]],
  },
  {
    name: "session close --task without an attachment",
    env: { KANEO_SESSION_ID: "sess-test" },
    // Named the way `session status` prints it, so a reference read off the
    // history can be handed straight back.
    steps: [["session", "close", "--task", "ALP#2", "--strict", "--json"]],
  },
  // A close whose marker the server did not keep still clears the attachment
  // here: the local record is brought up to date before the marker is confirmed,
  // so a machine never says it holds a task the server has let go of.
  {
    name: "session close keeps the local record when the marker is not confirmed",
    env: { KANEO_SESSION_ID: "sess-test" },
    // The closed marker alone, so the attach above it is confirmed as usual.
    dropCommentsMatching: "state=closed",
    steps: [["session", "attach", "1", "--strict"], ["session", "close", "--strict"], ["session", "status", "--json"]],
  },
  // The listing that would confirm the closed marker fails: the close is done here
  // and fail-open stays quiet about the unverified marker unless --strict asks.
  {
    name: "session close when the listing fails",
    env: { KANEO_SESSION_ID: "sess-test" },
    failOn: "^GET /comment/task-a1$",
    steps: [["session", "close", "--task", "1"], ["session", "close", "--task", "1", "--strict"]],
  },
  // The held task is gone from the server, so the marker cannot be written; the
  // attachment is released anyway and the close says so even without --strict.
  {
    name: "session close releases a task the server no longer has",
    env: { KANEO_SESSION_ID: "sess-test" },
    steps: [["session", "attach", "1", "--strict"], ["task", "rm", "1", "--yes", "--json"], ["session", "close"], ["session", "status", "--json"]],
  },
  // Named the way the attachment knows it, a gone task is still released: by
  // id, as session status prints it (in another case), and as a bare number in
  // its own project. The close hook runs for each release.
  {
    name: "session close --task releases a held task the server no longer has",
    env: { KANEO_SESSION_ID: "sess-test" },
    config: { hooks: { close: 'printf "%s %s\\n" "$KANEO_HOOK_EVENT" "$KANEO_TASK_ID" >> "$HOME/.config/kaneo/hook.out"' } },
    steps: [
      ["session", "attach", "1", "--strict"],
      ["task", "rm", "1", "--yes", "--json"],
      ["session", "close", "--task", "task-a1"],
      ["session", "attach", "2", "--strict"],
      ["task", "rm", "2", "--yes", "--json"],
      ["session", "close", "--task", "alp#2", "--json"],
      ["session", "attach", "3", "--strict"],
      ["task", "rm", "3", "--yes", "--json"],
      ["session", "close", "--task", "3"],
      ["session", "status", "--json"],
    ],
  },
  // Any other failure of the marker keeps the attachment, so the close can be
  // run again once the server answers.
  {
    name: "session close keeps the attachment when the marker post fails",
    env: { KANEO_SESSION_ID: "sess-test" },
    failOn: "^POST /comment/task-a1$",
    failOnSkip: 1,
    steps: [["session", "attach", "1", "--strict"], ["session", "close"], ["session", "status", "--json"]],
  },
  {
    name: "session status without a session id",
    env: { KANEO_SESSION_ID: "" },
    steps: [["session", "status", "--json"]],
  },
  // A session file that is valid JSON but not an attachment — "null", "3" — is
  // as unreadable as a broken one: status says nothing is held rather than
  // printing fields that are not there, and close says so instead of failing
  // on them. --strict is accepted and changes nothing, since status is not
  // fail-open.
  {
    name: "session status and close with an unreadable attachment",
    env: { KANEO_SESSION_ID: "sess-bad" },
    homeFiles: { ".config/kaneo/sessions/sess-bad.json": "3" },
    steps: [
      ["session", "status", "--json"],
      ["session", "status", "--human"],
      ["session", "status", "--strict", "--json"],
      ["session", "close", "--strict"],
    ],
  },
  // A record written before the slug was kept names its board by id rather than
  // reading as the current project's task of that number.
  {
    name: "session status names a slug-less record by project id",
    env: { KANEO_SESSION_ID: "sess-old" },
    homeFiles: {
      ".config/kaneo/sessions/sess-old.json": '{"taskId":"task-a1","number":1,"title":"Write the parser","projectId":"proj-alpha"}',
    },
    steps: [["session", "status", "--human"], ["session", "status", "--json"]],
  },
  // With no board fields at all the task id is the only name that still
  // resolves, so it is what the record is shown as.
  {
    name: "session status names a record with no board by task id",
    env: { KANEO_SESSION_ID: "sess-older" },
    homeFiles: {
      ".config/kaneo/sessions/sess-older.json": '{"taskId":"task-a1","number":1,"title":"Write the parser"}',
    },
    steps: [["session", "status", "--human"]],
  },
  // A bare number in --task names the held task even when the project the
  // session works in is another: resolving it would close that project's task
  // of the same number.
  {
    name: "session close --task bare number keeps the held task's project",
    env: { KANEO_SESSION_ID: "sess-xproj" },
    steps: [
      ["session", "attach", "BET#1", "--strict"],
      ["session", "close", "--task", "1", "--strict"],
      ["session", "status", "--json"],
    ],
  },
  // The history is appended before the attachment is dropped, on close as on
  // attach: when the append fails the attachment stays, so the act can be run
  // again once the file can be written.
  {
    name: "session keeps the attachment when the history append fails",
    env: { KANEO_SESSION_ID: "sess-ord" },
    homeDirs: [".config/kaneo/sessions/sess-ord.history.jsonl"],
    steps: [
      ["session", "attach", "1", "--strict"],
      ["session", "close", "--strict"],
      ["session", "status", "--json"],
    ],
  },
  // The board lookups a close makes for a task it does not hold are the
  // close's, not an attach's.
  {
    name: "session close debug names its own board lookup",
    env: { KANEO_SESSION_ID: "sess-test", KANEO_DEBUG: "1" },
    failOn: "^GET /project/proj-alpha$",
    steps: [["session", "close", "--task", "task-a1"]],
  },
  // A marker left by a session whose host is gone — an imported board carries
  // them — is released by naming the session: the closed marker is posted for
  // that id on the task --task resolves, and the board stops listing the hold.
  {
    name: "session close --session releases another session's hold",
    env: { KANEO_SESSION_ID: "sess-here" },
    seed: {
      comments: [
        { taskId: "task-a1", content: "<!-- kn:session id=sess-gone host=oldhost cwd=/old branch=main state=running enc=1 -->\nnext step" },
        { taskId: "task-a2", content: "<!-- kn:session id=sess-gone2 host=oldhost cwd=/old branch=main state=running enc=1 -->" },
      ],
    },
    steps: [
      ["board", "--human"],
      ["session", "close", "--session", "sess-gone", "--task", "1", "--human"],
      ["session", "close", "--session", "sess-gone2", "--task", "2", "--json"],
      ["board", "--human"],
    ],
  },
  // The hold has to be there: a closed marker for a session that is not
  // holding the task records an ending that never began. The refusal is
  // reported without --strict too: --session is a manual release, and a
  // refusal that exited 0 would report one that never ran.
  {
    name: "session close --session refuses a session not holding the task",
    env: { KANEO_SESSION_ID: "sess-here" },
    seed: {
      comments: [
        { taskId: "task-a1", content: "<!-- kn:session id=sess-live host=h cwd=/w branch=b state=running enc=1 -->" },
      ],
    },
    steps: [
      ["session", "close", "--session", "sess-ghost", "--task", "1"],
      ["session", "close", "--session", "sess-ghost", "--task", "1", "--strict"],
    ],
  },
  // --task names the task the hold is on; there is no attachment here to
  // default to.
  {
    name: "session close --session needs --task",
    env: { KANEO_SESSION_ID: "sess-here" },
    steps: [
      ["session", "close", "--session", "sess-gone"],
      ["session", "close", "--session", "sess-gone", "--strict"],
    ],
  },
  // This session's own hold is a plain close's job; releasing it by name here
  // would post a second marker for a hold about to be let go anyway.
  {
    name: "session close --session refuses this session's own id",
    env: { KANEO_SESSION_ID: "sess-here" },
    steps: [
      ["session", "attach", "1", "--strict"],
      ["session", "close", "--session", "sess-here", "--task", "1"],
      ["session", "close", "--session", "sess-here", "--task", "1", "--strict"],
      ["session", "status", "--json"],
    ],
  },
  // A bare --task number is read on the board the releasing session's record
  // names: the hold being released is that session's. The record says ALP
  // while the configured project is BET, and the session holds #1 on both —
  // the release must land on ALP#1, not the BET#1 a bare number would
  // otherwise resolve to.
  {
    name: "session close --session bare number keeps the releasing session's project",
    env: { KANEO_SESSION_ID: "sess-here", KANEO_PROJECT: P2 },
    homeFiles: {
      ".config/kaneo/sessions/sess-gone.json":
        '{"taskId":"task-a1","number":1,"title":"Write the parser","projectId":"proj-alpha","projectName":"Alpha","projectSlug":"ALP","workspaceId":"ws-main","workspaceName":"Main"}',
    },
    seed: {
      comments: [
        { taskId: "task-a1", content: "<!-- kn:session id=sess-gone host=oldhost cwd=/old branch=main state=running enc=1 -->\nnext step" },
        { taskId: "task-b1", content: "<!-- kn:session id=sess-gone host=oldhost cwd=/old branch=main state=running enc=1 -->\nnext step" },
      ],
    },
    steps: [
      ["session", "close", "--session", "sess-gone", "--task", "1", "--human"],
      ["board", "-p", "ALP", "--human"],
      ["board", "-p", "BET", "--human"],
    ],
  },
  // A task that moves keeps its id, and the session's attachment is a snapshot
  // from attach time: the move rewrites it, so status names the board and
  // number the task has now rather than the ones it had then.
  {
    name: "task move updates the session attachment",
    env: { KANEO_SESSION_ID: "sess-move" },
    steps: [
      ["session", "attach", "1", "--strict"],
      ["task", "move", "1", "--to", "BET", "--json"],
      ["session", "status", "--json"],
      ["session", "status", "--human"],
    ],
  },
  // A record the Python implementation left in its own directory is migrated
  // by the move's rewrite: the attachment is saved where this CLI keeps
  // records and the legacy copy is removed, since left behind it would keep
  // the pre-move snapshot — and a close there would remove only its own copy
  // while this one went on reporting the hold.
  {
    name: "task move migrates a legacy session record",
    env: { KANEO_SESSION_ID: "sess-legacy" },
    homeFiles: {
      ".config/kn/sessions/sess-legacy.json": '{"taskId":"task-a1","number":1,"title":"Write the parser"}',
    },
    steps: [
      ["session", "status", "--json"],
      ["task", "move", "1", "--to", "BET", "--json"],
      ["session", "status", "--json"],
    ],
  },
  ...both("board", ["board"]),
  ...both("board archived", ["board", "--archived"]),
  { name: "board pages past one page", pageSize: 2, steps: [["task", "ls", "--all", "--json"], ["board", "--json"]] },
  // The board gains a task while it is being read, so the total the listing
  // reports moves under the reader and the read is taken again.
  { name: "board changed mid-read", pageSize: 2, growOnPage: 2, growTimes: 1, steps: [["task", "ls", "--all", "--json"]] },
  // A board that keeps moving is reported rather than passed on as if it were
  // whole.
  { name: "board keeps changing", pageSize: 2, growOnPage: 2, steps: [["task", "ls", "--all", "--json"]] },
  // The board's order changes while it is read with the total held steady:
  // the same task answered on two task pages is a moved board, and the read is
  // taken again rather than answered short a task.
  {
    name: "board reordered mid-read",
    pageSize: 2,
    extraTasks: [{ id: "task-a4", projectId: P1, title: "Fourth" }],
    promoteOnPage: 2,
    promoteTaskId: "task-a4",
    promoteTimes: 1,
    steps: [["task", "ls", "--all", "--json"], ["board", "--json"]],
  },
  // A session can attach to a planned or archived task, so the board reports
  // those holds too: the session list reads every task the listing answered,
  // not only the open columns.
  {
    name: "board lists sessions on planned and archived tasks",
    seed: {
      comments: [
        { taskId: "task-p1", content: "<!-- kn:session id=sess-planned host=h1 cwd=/w branch=b state=running enc=1 -->\nnext" },
        { taskId: "task-arch1", content: "<!-- kn:session id=sess-arch host=h2 cwd=/w branch=b state=running enc=1 -->\nnext" },
      ],
    },
    extraTasks: [
      { id: "task-p1", projectId: P1, title: "Planned held", status: "planned" },
      { id: "task-arch1", projectId: P1, title: "Archived held", status: "archived" },
    ],
    steps: [["board", "--json"], ["board", "--human"]],
  },

  ...both("api-check", ["api-check"]),
  ...both("api-check request drift", ["api-check"]).map((s): Scenario => ({ ...s, driftedSpec: true })),
  // A missing operation exits 1, and --json still prints one document.
  ...both("api-check missing operation", ["api-check"]).map((s): Scenario => ({ ...s, specWithoutOperation: true })),

  { name: "no api key", env: { KANEO_API_KEY: "" }, steps: [["whoami"], ["task", "ls"]] },
  { name: "wrong api key", env: { KANEO_API_KEY: "nope" }, steps: [["whoami", "--json"], ["task", "ls", "--json"]] },
  { name: "no workspace", env: { KANEO_WORKSPACE: "" }, steps: [["project", "ls", "--json"]] },
  { name: "no project", env: { KANEO_PROJECT: "" }, steps: [["task", "ls", "--json"]] },
  { name: "unknown command", steps: [["frobnicate"]] },
  { name: "unknown subcommand", steps: [["task", "frob"], ["comment", "nope", "--json"], ["session", "x"], ["task"]] },
  ...[
    ["--help"],
    ["help"],
    ["help", "project"],
    ["task", "--help"],
    ["task", "create", "--help"],
    ["project", "get", "--help"],
    ["session"],
    ["session", "next", "--help"],
    ["project", "update", "--help"],
    // The integrations' set --help is the only user-facing list of the event
    // toggles, the reminder lead and the stdin convention besides the README.
    ["integration", "--help"],
    ["integration", "mattermost", "set", "--help"],
    ["integration", "webhook", "set", "--help"],
    ["integration"],
    ["integration", "gitea"],
    ["integration", "gitea", "connect", "--help"],
    ["integration", "gitea", "import", "--help"],
    // The close help is where the --task reference forms are written down.
    ["session", "close", "--help"],
  ].map((args, i): Scenario => ({ name: `help ${i + 1}: ${args.join(" ")}`, steps: [args] })),
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
  // A 429 is waited out, up to three times and a minute of waiting, and is
  // reported as it came past either.
  { name: "rate limit waited out", rateLimitTimes: 2, rateLimitWaitMs: 200, steps: [["workspace", "ls", "--human"]] },
  { name: "rate limit longer than the budget", rateLimitTimes: 1, rateLimitWaitMs: 61000, steps: [["workspace", "ls", "--human"]] },
  { name: "rate limit past the retries", rateLimitTimes: 5, rateLimitWaitMs: 0, steps: [["workspace", "ls", "--json"]] },
  // Each attempt gets a --timeout of its own: two 200 ms waits pass a 300 ms one.
  { name: "rate limit waits outlast one timeout", rateLimitTimes: 2, rateLimitWaitMs: 200, steps: [["workspace", "ls", "--human", "--timeout", "300ms"]] },
  // Only the limiter's own answer is waited for.
  { name: "a 429 that is not the rate limiter", rateLimitTimes: 1, rateLimitWaitMs: 0, rateLimitCode: "IMPORT_RUNNING", steps: [["workspace", "ls", "--human"]] },
  // A fail-open command run from a hook does not sit a rate limit out, and says
  // nothing; --strict does wait.
  {
    name: "rate limit in a fail-open command",
    env: { KANEO_SESSION_ID: "sess-test" },
    rateLimitTimes: 1,
    rateLimitWaitMs: 0,
    steps: [["session", "attach", "1"], ["session", "status", "--json"]],
  },
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
  // Each request alone fits in the timeout, and the command's requests together
  // do not. Every request gets the whole of it, so both steps pass; one budget
  // for the command failed a board that takes several pages.
  { name: "one timeout per request", delayMs: 400, env: { KANEO_SESSION_ID: "sess-budget" }, steps: [["session", "attach", "1", "--strict", "--timeout", "1s"], ["board", "--json", "--timeout", "1s"]] },
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
      ["context", "--repo", "host:../x", "--json"],
      ["context", "--repo", "host:acme/..", "--json"],
    ],
  },
  {
    // The maps are keyed by owner/repo, so the host a user-less scp remote
    // names is dropped as it is for the other forms.
    name: "context --repo takes a user-less scp remote",
    env: { KANEO_WORKSPACE: "", KANEO_PROJECT: "" },
    config: { owners: { acme: "ws-acme" }, repos: { "acme/thing": ["proj-x"] } },
    steps: [["context", "--repo", "github.com:acme/thing", "--json"]],
  },
  {
    name: "--api-url and --api-key beat the environment",
    env: { KANEO_API_URL: "http://127.0.0.1:9", KANEO_API_KEY: "wrong-key" },
    steps: [["whoami", "--json", "--api-url", "<URL>", "--api-key", "test-key"], ["context", "--json", "--api-url", "<URL>"]],
  },
  {
    // The key comes from the command's stdout, trailing newline and all, and
    // context names the command as the layer that answered. whoami reads the
    // key before it sends and again for each request, and "ran" on stderr once
    // per step shows the command runs once per process.
    name: "api_key_command supplies the key",
    env: { KANEO_API_KEY: "" },
    config: { profiles: { self: { api_key_command: "echo ran >&2; printf 'test-key\\n'" } } },
    steps: [["whoami", "--json"], ["context", "--repo", "acme/thing", "--json"]],
  },
  {
    name: "the profile's api_key beats api_key_command",
    env: { KANEO_API_KEY: "" },
    config: { profiles: { self: { api_key: "test-key", api_key_command: "echo ran >&2; exit 7" } } },
    steps: [["whoami", "--json"]],
  },
  {
    name: "--api-key beats api_key_command",
    env: { KANEO_API_KEY: "" },
    config: { profiles: { self: { api_key_command: "echo ran >&2; exit 7" } } },
    steps: [["whoami", "--json", "--api-key", "test-key"]],
  },
  {
    // Commands that send no request, or only a request that needs no key
    // (api-check, the instance and public reads, an avatar download, a feed
    // download), never run it, and a fail-open session command that needs
    // the key still exits 0 when the command fails. whoami at the end is the
    // contrast: it does need the key, so the command runs and fails the step.
    name: "a failing api_key_command spares commands that send no key",
    env: { KANEO_API_KEY: "", KANEO_SESSION_ID: "sess-cmd" },
    config: { profiles: { self: { api_key_command: "echo ran >&2; exit 3" } } },
    // The calendar route declares security: [], so `feed get` is one of the
    // commands that send no key; the seeded feed's empty labels still serve.
    seed: {
      calendarFeeds: [{ projectId: P1 }],
      projects: [
        ...SEED.projects,
        { id: "proj-public", workspaceId: WS, name: "Public", slug: "PUB", isPublic: true, description: "shared board ".repeat(90) },
      ],
      avatars: [{ id: "av-1", body: "avatar-one-bytes", contentType: "image/webp" }],
    },
    extraTasks: [{ id: "task-pub1", projectId: "proj-public", title: "Public first" }],
    steps: [
      ["completion", "bash"],
      ["__complete", "task", ""],
      ["session", "status", "--json"],
      ["session", "attach", "1"],
      ["context", "--json"],
      ["context", "--human"],
      ["api-check", "--json"],
      ["feed", "get", feedToken(1)],
      ["instance", "status", "--json"],
      ["instance", "config", "--json"],
      ["public", "project", "proj-public", "--json"],
      ["public", "description", "proj-public", "--json"],
      ["avatar", "get", "av-1", "--out", "face.webp", "--json"],
      ["whoami", "--json"],
    ],
  },
  {
    name: "api_key_command printing too much",
    env: { KANEO_API_KEY: "" },
    config: { profiles: { self: { api_key_command: "head -c 70000 /dev/zero | tr '\\0' a" } } },
    steps: [["whoami", "--json"]],
  },
  {
    // A stronger layer answers first, so the command never runs: if it did,
    // its exit status would fail the run.
    name: "api_key_command does not run when the environment has a key",
    config: { profiles: { self: { api_key_command: "echo ran >&2; exit 7" } } },
    steps: [["whoami", "--json"]],
  },
  {
    name: "a failing api_key_command stops the run",
    env: { KANEO_API_KEY: "" },
    config: { profiles: { self: { api_key_command: "echo 'no secret here' >&2; exit 3" } } },
    steps: [["whoami", "--json"]],
  },
  {
    name: "api_key_command printing nothing",
    env: { KANEO_API_KEY: "" },
    config: { profiles: { self: { api_key_command: "true" } } },
    steps: [["whoami", "--json"]],
  },
  {
    // Refused without the value being echoed back.
    name: "api_key_command printing a value with a space",
    env: { KANEO_API_KEY: "" },
    config: { profiles: { spaced: { api_key_command: "printf 'two words'" } } },
    steps: [["whoami", "--json"]],
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
  // Columns and workflow rules take the same values as tasks do.
  { name: "project by slug for columns and workflow rules", steps: [["column", "ls", "-p", "BET", "--human"], ["column", "create", "Waiting", "-p", "bet", "--human"], ["column", "rename", "waiting", "Held", "-p", "Beta", "--human"], ["column", "reorder", "to-do", "in-progress", "waiting", "done", "-p", "BET", "--human"], ["workflow", "set", "github", "pr_opened", "Held", "-p", "BET", "--human"], ["workflow", "ls", "-p", "BET", "--human"], ["workflow", "rm", "github", "pr_opened", "-p", "BET", "--human"], ["column", "rm", "waiting", "--yes", "-p", "BET", "--human"], ["column", "rm", "to-do", "--yes", "-p", "BET", "--json"], ["column", "ls", "-p", "nope", "--json"], ["column", "create", "Waiting", "-p", "nope", "--json"], ["workflow", "ls", "-p", "nope", "--json"], ["workflow", "set", "github", "pr_opened", "done", "-p", "nope", "--json"]] },
  // With no project configured, a hint naming the task by number would not
  // resolve at all; it names the task by id, and that command, as printed in
  // step 1, lists the task's comments with no project.
  { name: "comment delete hint with no project configured", env: { KANEO_PROJECT: "", KANEO_WORKSPACE: "" }, steps: [["comment", "delete", "BET#1", "nope", "--json"], ["comment", "list", "task-b1", "--json"], ["comment", "list", "1", "--json"]] },
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
  // A workspace's name where a project's belongs, for a task number (in a
  // reference or by -p): the error says numbers are per project and names the
  // projects that can hold the number. Elsewhere a value that names no project
  // gets the plain message.
  {
    name: "task reference with a workspace name",
    steps: [
      ["task", "get", "Main#3", "--human"],
      ["task", "get", "main#9", "--human"],
      ["task", "get", "other#1", "--human"],
      ["task", "get", "nowhere#1", "--human"],
      ["task", "get", "3", "-p", "Main", "--human"],
      ["project", "get", "Main", "--human"],
    ],
  },
  { name: "task reference with a workspace name to an older server", legacy: true, steps: [["task", "get", "Main#2", "--human"]] },
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
    name: "project list with an empty slug",
    seed: { projects: [...SEED.projects, { id: "proj-noslug", workspaceId: WS, name: "No slug", slug: "" }] },
    steps: [["project", "ls", "--human"], ["project", "ls", "-A", "--human"], ["project", "ls", "-A", "--json"]],
  },
  {
    // A project with no slug is named without an empty [] or a leading blank,
    // both in the refusal and among the projects a name matches.
    name: "project rm and a name match with an empty slug",
    seed: {
      projects: [
        ...SEED.projects,
        { id: "proj-noslug", workspaceId: WS, name: "Twin", slug: "" },
        { id: "proj-twin", workspaceId: WS, name: "Twin", slug: "TWN" },
      ],
    },
    steps: [["project", "rm", "proj-noslug", "--human"], ["project", "rm", "Twin", "--human"]],
  },
  {
    // The other messages that name a project or a workspace by its slug fall
    // back to the id (or, in an export, the name) when the slug is empty.
    name: "messages naming a project or workspace with an empty slug",
    seed: {
      workspaces: [...SEED.workspaces, { id: "ws-twin", name: "Twin", slug: "" }, { id: "ws-twin2", name: "Twin", slug: "tw2" }],
      projects: [...SEED.projects, { id: "proj-noslug", workspaceId: WS, name: "No slug", slug: "" }],
      tasks: [...SEED.tasks, { id: "task-n1", projectId: "proj-noslug", title: "Slugless" }],
    },
    steps: [
      ["task", "bulk", "1", "proj-noslug#1", "--delete", "--human"],
      ["column", "create", "Waiting", "--json"],
      ["task", "bulk", "1", "proj-noslug#1", "--status", "waiting", "--human"],
      ["task", "export", "-p", "proj-noslug", "--human"],
      ["project", "reorder", "Alpha", "Beta", "--human"],
      ["project", "ls", "-w", "Twin", "--human"],
      ["task", "get", "proj-noslug#9", "--human"],
    ],
  },
  {
    // Every reference to a task of a project with no slug names the project by
    // its id, so none of them reads as the current project's #N. The tasks
    // named by id were found without reading a board, so bulk has no slug for
    // them either.
    name: "references to a project with an empty slug",
    env: { KANEO_SESSION_ID: "sess-test" },
    seed: {
      projects: [...SEED.projects, { id: "proj-noslug", workspaceId: WS, name: "No slug", slug: "" }],
      tasks: [...SEED.tasks, { id: "task-n1", projectId: "proj-noslug", title: "Slugless" }],
    },
    steps: [
      ["session", "attach", "proj-noslug#1", "--strict"],
      ["session", "status", "--human"],
      ["task", "bulk", "task-n1", "ALP#1", "--delete", "--human"],
      ["search", "Slugless", "--human"],
      ["session", "close", "--strict"],
      ["session", "status", "--human"],
      ["session", "attach", "proj-noslug#1", "--strict"],
      ["task", "rm", "1", "-p", "proj-noslug", "--yes", "--json"],
      ["session", "close"],
    ],
  },
  {
    // One workspace refusing its listing leaves the other's projects printed and
    // the failure on stderr with a non-zero exit, in both output modes.
    name: "project list across workspaces with one workspace unlisted",
    seed: { projects: [...SEED.projects, { id: "proj-gamma", workspaceId: "ws-other", name: "Gamma", slug: "GAM" }] },
    failOn: "^GET /project$",
    failOnQuery: "workspaceId=ws-other",
    failStatus: 403,
    steps: [["project", "ls", "-A", "--human"], ["project", "ls", "-A", "--json"]],
  },
  {
    name: "project find with one workspace unlisted",
    seed: { projects: [...SEED.projects, { id: "proj-gamma", workspaceId: "ws-other", name: "Gamma", slug: "GAM" }] },
    failOn: "^GET /project$",
    failOnQuery: "workspaceId=ws-other",
    failStatus: 403,
    steps: [["project", "find", "be", "--human"], ["project", "find", "gam", "--human"]],
  },
  {
    // A slug that is found in a listed workspace still resolves; one that is
    // not found says a workspace could not be listed instead of claiming no
    // project has the name.
    name: "project lookup with one workspace unlisted",
    failOn: "^GET /project$",
    failOnQuery: "workspaceId=ws-other",
    failStatus: 403,
    steps: [["task", "ls", "-p", "BET", "--human"], ["task", "ls", "-p", "nope", "--human"], ["task", "ls", "-p", "Beta", "--human"], ["task", "ls", "-p", "proj-beta", "--human"]],
  },
  {
    // The hint a caller adds to a value that names no project survives the
    // lookup missing while a workspace is unlisted.
    name: "task reference with a workspace name and one workspace unlisted",
    failOn: "^GET /project$",
    failOnQuery: "workspaceId=ws-other",
    failStatus: 403,
    steps: [["task", "get", "Main#3", "--human"]],
  },
  {
    name: "project list across workspaces refuses a workspace",
    steps: [["project", "ls", "-A", "-w", "ws-main", "--human"]],
  },
  {
    // A second match in the second workspace, so the search reaching outside the
    // workspace the settings name is what the output shows.
    name: "project find",
    seed: { projects: [...SEED.projects, { id: "proj-beacon", workspaceId: "ws-other", name: "Beacon", slug: "BCN" }] },
    steps: [["project", "find", "be", "--json"], ["project", "find", "OLD", "--human"], ["project", "find", "zzz", "--json"]],
  },

  // Gitea integration: the whole lifecycle against the fake's one instance.
  // Every step is handed the same stdin; only the ones passing --token - read it.
  {
    name: "integration gitea lifecycle",
    seed: {
      giteaRepositories: [
        { owner: "acme", name: "app", private: true },
        { owner: "acme", name: "docs" },
      ],
    },
    stdin: "fake-gitea-token\n",
    steps: [
      ["integration", "gitea", "get", "--json"],
      ["integration", "gitea", "verify", "acme/app", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      ["integration", "gitea", "repos", "--base-url", "https://gitea.example.com", "--token", "-", "--human"],
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      ["integration", "gitea", "get", "--human"],
      ["integration", "gitea", "update", "--active=false", "--comment-task-link=false", "--json"],
      // No --token: the stored one answers because the base URL is unchanged.
      ["integration", "gitea", "verify", "acme/app", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "rm", "--yes", "--json"],
      ["integration", "gitea", "get", "--json"],
    ],
  },
  // The key may read the integration but not manage the workspace's settings,
  // so the webhook secret comes back empty rather than stored, and every
  // manageAccess route refuses the write. import is no manageAccess route — it
  // asks for task permissions a member has — so it still runs.
  {
    name: "integration gitea get as a plain member",
    plainMember: true,
    stdin: "fake-gitea-token\n",
    seed: {
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      giteaRepoIssues: [{ baseUrl: "https://gitea.example.com", repositoryOwner: "acme", repositoryName: "app", issues: [{ number: 1, title: "Member may import this" }] }],
    },
    steps: [
      ["integration", "gitea", "get", "--human"],
      ["integration", "gitea", "get", "--json"],
      ["integration", "gitea", "update", "--active=false", "--json"],
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "rm", "--yes", "--json"],
      ["integration", "gitea", "verify", "acme/app", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "repos", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      ["integration", "gitea", "import", "--json"],
    ],
  },
  // The stored token answers verify and connect only while the normalized base
  // URL is the saved integration's; a moved instance needs a new token.
  {
    name: "integration gitea stored token rules",
    seed: {
      giteaRepositories: [
        { owner: "acme", name: "app" },
        { owner: "acme", name: "other" },
      ],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "scenario-stored-token", repositoryOwner: "acme", repositoryName: "app" }],
    },
    steps: [
      ["integration", "gitea", "verify", "acme/app", "--base-url", "https://gitea.example.com/", "--json"],
      ["integration", "gitea", "verify", "acme/app", "--base-url", "https://gitea.example.com/gitea", "--json"],
      // Reconnecting on the same instance keeps the stored token and moves the
      // link to the other repository.
      ["integration", "gitea", "connect", "acme/other", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "get", "--json"],
    ],
  },
  // verify reports each check in the body rather than failing the request.
  {
    name: "integration gitea verify reports",
    seed: {
      giteaRepositories: [
        { owner: "acme", name: "app" },
        { owner: "acme", name: "readonly", canWriteIssues: false, private: true },
      ],
    },
    stdin: "fake-gitea-token\n",
    steps: [
      ["integration", "gitea", "verify", "acme/app", "--base-url", "https://gitea.example.com", "--token", "-", "--human"],
      ["integration", "gitea", "verify", "acme/readonly", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      ["integration", "gitea", "verify", "acme/missing", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      // With no integration stored and no token sent, the server refuses.
      ["integration", "gitea", "verify", "acme/app", "--base-url", "https://gitea.example.com", "--json"],
    ],
  },
  {
    name: "integration gitea verify not a gitea instance",
    seed: { giteaInstance: { mode: "not-gitea" } },
    stdin: "fake-gitea-token\n",
    steps: [["integration", "gitea", "verify", "acme/app", "--base-url", "https://example.com", "--token", "-", "--json"]],
  },
  {
    name: "integration gitea verify redirected",
    seed: { giteaInstance: { mode: "redirected" } },
    stdin: "fake-gitea-token\n",
    steps: [["integration", "gitea", "verify", "acme/app", "--base-url", "http://gitea.example.com", "--token", "-", "--json"]],
  },
  // Every route that trusts a token fails the same way when the instance
  // rejects it.
  {
    name: "integration gitea bad token",
    seed: { giteaInstance: { mode: "bad-token" }, giteaRepositories: [{ owner: "acme", name: "app" }] },
    stdin: "fake-gitea-token\n",
    steps: [
      ["integration", "gitea", "repos", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
    ],
  },
  {
    name: "integration gitea connect needs a reachable repository",
    seed: { giteaRepositories: [{ owner: "acme", name: "app" }] },
    stdin: "fake-gitea-token\n",
    steps: [
      ["integration", "gitea", "connect", "acme/missing", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      // No stored integration and no token sent: the server asks for one.
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--json"],
      // A token is a credential, so a literal flag value is refused client-side.
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--token", "literal", "--json"],
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://other.example.com", "--token", "-", "--json"],
      // The stored token belongs to the instance it was saved for.
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
    ],
  },
  // A repository already linked to another project cannot be linked again.
  {
    name: "integration gitea connect repository already linked",
    seed: {
      giteaRepositories: [{ owner: "acme", name: "app" }],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
    },
    stdin: "fake-gitea-token\n",
    steps: [
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--token", "-", "-p", "proj-beta", "--json"],
      ["integration", "gitea", "rm", "--yes", "-p", "proj-beta", "--json"],
    ],
  },
  // The argument and --base-url are judged before stdin is read: with empty
  // stdin, a --token - read first would fail on the token instead, so these
  // steps also pin that order. The last one reaches the token read itself.
  {
    name: "integration gitea refuses bad input before reading the token",
    stdin: "",
    steps: [
      ["integration", "gitea", "verify", "acme/app", "--token", "-", "--json"],
      ["integration", "gitea", "connect", "acme", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      ["integration", "gitea", "connect", "acme/app/extra", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
      ["integration", "gitea", "repos", "--base-url", "https://gitea.example.com", "--token", "-", "--json"],
    ],
  },
  {
    name: "integration gitea update needs a change",
    seed: { giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }] },
    steps: [
      ["integration", "gitea", "update", "--json"],
      ["integration", "gitea", "update", "--active=false", "--json"],
      ["integration", "gitea", "update", "--comment-task-link=false", "--json"],
    ],
  },
  // The update route's 404 is the document's {"error": ...} JSON, which the
  // error line shows as the raw body.
  {
    name: "integration gitea update without integration",
    steps: [["integration", "gitea", "update", "--active=false", "--json"]],
  },
  // The delete cascades to the external links the integration made, as the
  // integration table's onDelete does upstream; the imported task and the
  // link added by hand stay.
  {
    name: "integration gitea rm needs --yes",
    seed: {
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      externalLinks: [
        { taskId: "task-a1", url: "https://gitea.example.com/acme/app/issues/7", title: "Write the parser", resourceType: "issue", externalId: "7", integration: { id: "git0001", type: "gitea" } },
        { taskId: "task-a1", url: "https://example.com/notes", title: "Notes" },
      ],
    },
    steps: [
      ["task", "external-links", "1", "--json"],
      ["integration", "gitea", "rm", "--human"],
      ["integration", "gitea", "rm", "--yes", "--json"],
      ["task", "external-links", "1", "--json"],
      ["integration", "gitea", "rm", "--yes", "--json"],
    ],
  },
  // The import brings in open issues only: issue 3 is closed and never seen,
  // issue 6 is a pull request the issue listing also carries and upstream
  // drops before importing, issue 4 imports like any other open issue — the
  // pinned release has no incoming-rule gate — issue 5 fails outright, and
  // issue 7 is already linked to task-a1 (external id "7", integration
  // git0001 — the first gitea row the fake numbers) so it refreshes instead
  // of duplicating.
  {
    name: "integration gitea import",
    seed: {
      giteaRepositories: [{ owner: "acme", name: "app" }],
      giteaIntegrations: [
        {
          projectId: P1,
          baseUrl: "https://gitea.example.com",
          accessToken: "seeded-token",
          repositoryOwner: "acme",
          repositoryName: "app",
        },
      ],
      giteaRepoIssues: [
        {
          baseUrl: "https://gitea.example.com",
          repositoryOwner: "acme",
          repositoryName: "app",
          issues: [
            { number: 1, title: "Fix login bug", body: "Steps to reproduce", labels: ["bug", "priority:high", "status:in-progress"] },
            { number: 2, title: "Write the docs", labels: ["docs"] },
            { number: 3, title: "Already closed", state: "closed", labels: ["bug"] },
            { number: 4, title: "A chore with a wontfix label", labels: ["wontfix"] },
            { number: 5, title: "Cannot be fetched", labels: ["bug"], fail: "Gitea API error 502" },
            { number: 6, title: "A pull request, not an issue", labels: ["bug"], pullRequest: true },
            { number: 7, title: "Parser, refreshed", body: "refreshed body", labels: ["status:done", "priority:urgent"] },
          ],
        },
      ],
      externalLinks: [{ taskId: "task-a1", url: "https://gitea.example.com/acme/app/issues/7", title: "Write the parser", resourceType: "issue", externalId: "7", integration: { id: "git0001", type: "gitea" } }],
    },
    steps: [
      ["integration", "gitea", "import", "--json"],
      ["task", "ls", "--json"],
      ["task", "get", "4", "--json"],
      ["task", "get", "1", "--json"],
    ],
  },
  { name: "integration gitea import without integration", steps: [["integration", "gitea", "import", "--json"]] },
  {
    name: "integration gitea import inactive",
    seed: { giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app", isActive: false }] },
    steps: [["integration", "gitea", "import", "--json"]],
  },

  // The issue listing runs before any per-issue work and outside its error
  // handling, so an instance that rejects the stored token fails the whole
  // import with the server's plain 500 — nothing is imported.
  {
    name: "integration gitea import with a failing instance",
    seed: {
      giteaInstance: { mode: "bad-token" },
      giteaRepositories: [{ owner: "acme", name: "app" }],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      giteaRepoIssues: [{ baseUrl: "https://gitea.example.com", repositoryOwner: "acme", repositoryName: "app", issues: [{ number: 1, title: "Never imported" }] }],
    },
    steps: [["integration", "gitea", "import", "--json"]],
  },
  // A link whose task is gone — or belongs to another project — fails
  // findExternalLink's scope upstream, so the issue never reaches the
  // refresh path: it takes the create path, counts imported, and a fresh
  // task lands in the importing project. The stale link rows stay but
  // never match again, so the second import refreshes the new tasks, and
  // the foreign task keeps its title and labels.
  {
    name: "integration gitea import reimports links to missing or foreign tasks",
    seed: {
      giteaRepositories: [{ owner: "acme", name: "app" }],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      giteaRepoIssues: [
        {
          baseUrl: "https://gitea.example.com",
          repositoryOwner: "acme",
          repositoryName: "app",
          issues: [
            { number: 8, title: "Linked to a deleted task", labels: ["bug"] },
            { number: 9, title: "Linked to another project's task", labels: ["bug"] },
          ],
        },
      ],
      externalLinks: [
        { taskId: "task-gone", url: "https://gitea.example.com/acme/app/issues/8", title: "Old link", resourceType: "issue", externalId: "8", integration: { id: "git0001", type: "gitea" } },
        { taskId: "task-b1", url: "https://gitea.example.com/acme/app/issues/9", title: "Foreign link", resourceType: "issue", externalId: "9", integration: { id: "git0001", type: "gitea" } },
      ],
    },
    steps: [
      ["integration", "gitea", "import", "--json"],
      ["integration", "gitea", "import", "--json"],
      ["task", "ls", "--json"],
      ["task", "ls", "-p", "proj-beta", "--json"],
    ],
  },
  // The human import prints each failure and the summary, then exits 1 — the
  // --json steps elsewhere never show that path.
  {
    name: "integration gitea import human with errors",
    seed: {
      giteaRepositories: [{ owner: "acme", name: "app" }],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      giteaRepoIssues: [
        {
          baseUrl: "https://gitea.example.com",
          repositoryOwner: "acme",
          repositoryName: "app",
          issues: [
            { number: 1, title: "Imports fine", labels: ["bug"] },
            { number: 2, title: "Fails to import", fail: "Gitea API error 502" },
          ],
        },
      ],
    },
    steps: [["integration", "gitea", "import", "--human"]],
  },
  // The integration row's isActive column is nullable; a null reads as
  // "unknown" rather than active or inactive.
  {
    name: "integration gitea get with a null active flag",
    seed: { giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app", isActive: null }] },
    steps: [
      ["integration", "gitea", "get", "--human"],
      ["integration", "gitea", "get", "--json"],
    ],
  },

  // Reconnecting moves the link, and the issue list moves with the repository:
  // acme/other's own issues import, acme/third has none seeded so its import
  // is empty rather than acme/app's leftovers, and back on acme/app its own
  // list is what imports again.
  {
    name: "integration gitea reconnect lists the new repository's issues",
    seed: {
      giteaRepositories: [{ owner: "acme", name: "app" }, { owner: "acme", name: "other" }, { owner: "acme", name: "third" }],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      giteaRepoIssues: [
        { baseUrl: "https://gitea.example.com", repositoryOwner: "acme", repositoryName: "app", issues: [{ number: 1, title: "App issue" }] },
        { baseUrl: "https://gitea.example.com", repositoryOwner: "acme", repositoryName: "other", issues: [{ number: 2, title: "Other issue" }] },
      ],
    },
    steps: [
      ["integration", "gitea", "connect", "acme/other", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "import", "--json"],
      ["integration", "gitea", "connect", "acme/third", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "import", "--json"],
      ["integration", "gitea", "connect", "acme/app", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "import", "--json"],
      ["task", "ls", "--json"],
    ],
  },

  // The import matches an issue to a task by the integration and the issue
  // number, not the repository: connect keeps the integration row, so acme/other's
  // issue 1 refreshes the task acme/app's issue 1 was linked to — title,
  // priority and labels take the new repository's content — while the link
  // itself keeps pointing at the old repository's issue.
  {
    name: "integration gitea reconnect refreshes matching issue numbers",
    seed: {
      giteaRepositories: [{ owner: "acme", name: "app" }, { owner: "acme", name: "other" }],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      giteaRepoIssues: [
        { baseUrl: "https://gitea.example.com", repositoryOwner: "acme", repositoryName: "app", issues: [{ number: 1, title: "App issue one" }] },
        { baseUrl: "https://gitea.example.com", repositoryOwner: "acme", repositoryName: "other", issues: [{ number: 1, title: "Other issue one", labels: ["priority:urgent"] }] },
      ],
      externalLinks: [{ taskId: "task-a1", url: "https://gitea.example.com/acme/app/issues/1", title: "App issue one", resourceType: "issue", externalId: "1", integration: { id: "git0001", type: "gitea" } }],
    },
    steps: [
      ["integration", "gitea", "connect", "acme/other", "--base-url", "https://gitea.example.com", "--json"],
      ["integration", "gitea", "import", "--json"],
      ["task", "get", "1", "--json"],
      ["task", "external-links", "1", "--json"],
    ],
  },

  // move-task.ts deletes a moved task's links through integrations the
  // destination project does not own, so the source project's next import
  // finds no link for the issue and creates a fresh task in the source
  // project rather than refreshing the moved one.
  {
    name: "integration gitea import after the task moved projects",
    seed: {
      giteaRepositories: [{ owner: "acme", name: "app" }],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      giteaRepoIssues: [{ baseUrl: "https://gitea.example.com", repositoryOwner: "acme", repositoryName: "app", issues: [{ number: 1, title: "Gitea issue one", labels: ["bug"] }] }],
    },
    steps: [
      ["integration", "gitea", "import", "--json"],
      ["task", "move", "4", "--to", P2, "--json"],
      ["task", "external-links", "2", "-p", P2, "--json"],
      ["integration", "gitea", "import", "--json"],
      ["task", "ls", "--json"],
      ["task", "ls", "-p", P2, "--json"],
    ],
  },

  // external_link.task_id cascades on task delete upstream, on the single
  // and bulk routes alike, so removing an imported task takes its link
  // with it: the next import creates fresh tasks rather than counting the
  // issues skipped against links whose tasks are gone.
  {
    name: "integration gitea import after imported tasks are deleted",
    seed: {
      giteaRepositories: [{ owner: "acme", name: "app" }],
      giteaIntegrations: [{ projectId: P1, baseUrl: "https://gitea.example.com", accessToken: "seeded-token", repositoryOwner: "acme", repositoryName: "app" }],
      giteaRepoIssues: [
        {
          baseUrl: "https://gitea.example.com",
          repositoryOwner: "acme",
          repositoryName: "app",
          issues: [
            { number: 1, title: "Gitea issue one", labels: ["bug"] },
            { number: 2, title: "Gitea issue two", labels: ["docs"] },
          ],
        },
      ],
    },
    steps: [
      ["integration", "gitea", "import", "--json"],
      ["task", "external-links", "4", "--json"],
      ["task", "rm", "4", "--yes", "--json"],
      ["task", "bulk", "5", "--delete", "--yes", "--json"],
      ["integration", "gitea", "import", "--json"],
      ["task", "ls", "--json"],
    ],
  },

  // GitLab integration. The token only ever arrives on stdin, the stored link
  // answers it masked, and each refusal is the server's own words.
  {
    name: "integration gitlab get without a link",
    steps: [["integration", "gitlab", "get", "--human"], ["integration", "gitlab", "get", "--json"]],
  },
  ...both("integration gitlab get", ["integration", "gitlab", "get"]).map(
    (s): Scenario => ({ ...s, seed: { gitlabIntegrations: GITLAB } }),
  ),
  {
    // A plain member still reads the link, but the secrets come back empty and
    // the human line for the webhook secret is left out.
    name: "integration gitlab get as a plain member",
    plainMember: true,
    seed: { gitlabIntegrations: GITLAB },
    steps: [["integration", "gitlab", "get", "--human"], ["integration", "gitlab", "get", "--json"]],
  },
  {
    // connect reads the token from stdin, the link answers masked, update
    // changes only what is passed, import counts what it did, and rm removes
    // the link for good.
    name: "integration gitlab connect update import rm",
    stdin: "cli-token-0123456789abcdef\n",
    steps: [
      ["integration", "gitlab", "connect", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--token-type", "bearer", "--json"],
      ["integration", "gitlab", "get", "--human"],
      ["integration", "gitlab", "update", "--comment-task-link=false", "--json"],
      ["integration", "gitlab", "import", "--human"],
      ["integration", "gitlab", "rm", "--yes", "--json"],
      ["integration", "gitlab", "get", "--json"],
    ],
  },
  {
    // The stored token is reused only while the GitLab URL is unchanged; a
    // different instance needs a new one, and the server says so. The masked
    // token after the first connect is the seeded one, which is the proof the
    // stored credential was kept.
    name: "integration gitlab connect reuses or refuses the stored token",
    seed: { gitlabIntegrations: GITLAB },
    steps: [
      ["integration", "gitlab", "connect", "--base-url", "https://gitlab.example.com", "--project-path", "acme/other-project", "--human"],
      ["integration", "gitlab", "connect", "--base-url", "https://gitlab.other.example.com", "--project-path", "acme/web-app", "--human"],
      ["integration", "gitlab", "get", "--json"],
    ],
  },
  {
    name: "integration gitlab connect to a project linked elsewhere",
    seed: { gitlabIntegrations: GITLAB },
    stdin: "cli-token-0123456789abcdef\n",
    steps: [
      ["integration", "gitlab", "connect", "-p", P2, "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--human"],
      ["integration", "gitlab", "connect", "-p", P2, "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--json"],
    ],
  },
  {
    // The token is stdin-only: absent, a literal value and empty stdin are
    // each refused before a request is made, for every command that takes one.
    name: "integration gitlab token rules",
    stdin: "",
    steps: [
      ["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--human"],
      ["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "literal-value", "--json"],
      ["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--json"],
      ["integration", "gitlab", "projects", "--base-url", "https://gitlab.example.com", "--human"],
      ["integration", "gitlab", "projects", "--base-url", "https://gitlab.example.com", "--access-token", "literal-value", "--json"],
      ["integration", "gitlab", "connect", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "literal-value", "--json"],
      ["integration", "gitlab", "connect", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--json"],
    ],
  },
  {
    // The instance address is checked before the token is even looked at: a
    // value that is not a URL, plain http and a project path without a
    // namespace are each the server's own refusal.
    name: "integration gitlab refuses bad instance addresses",
    stdin: "addr-token-0123456789abcdef\n",
    steps: [
      ["integration", "gitlab", "connect", "--base-url", "gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--human"],
      ["integration", "gitlab", "connect", "--base-url", "http://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--human"],
      ["integration", "gitlab", "verify", "--base-url", "http://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--human"],
      ["integration", "gitlab", "projects", "--base-url", "http://gitlab.example.com", "--access-token", "-", "--human"],
      ["integration", "gitlab", "connect", "--base-url", "https://gitlab.example.com", "--project-path", "web-app", "--access-token", "-", "--human"],
    ],
  },
  {
    name: "integration gitlab verify",
    stdin: "verify-token-0123456789abcdef\n",
    steps: [
      ["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--json"],
      ["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--token-type", "bearer", "--human"],
    ],
  },
  {
    // A project the token cannot see is a 200 body, not an error status, and
    // the command exits 0: the check's findings are the answer, not a failure.
    name: "integration gitlab verify a project the token cannot see",
    stdin: "verify-token-0123456789abcdef\n",
    gitlabVerify: {
      isInstalled: false,
      hasRequiredPermissions: false,
      projectExists: false,
      projectVisibility: null,
      missingPermissions: [],
      message: "Project not found or not accessible with this token.",
      failureReason: "project_not_found",
    },
    steps: [
      ["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--human"],
      ["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--json"],
    ],
  },
  {
    name: "integration gitlab verify a token short of permissions",
    stdin: "verify-token-0123456789abcdef\n",
    gitlabVerify: {
      hasRequiredPermissions: false,
      missingPermissions: ["Developer"],
      message: "Token may not have sufficient permissions to manage issues and labels.",
    },
    steps: [["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--json"]],
  },
  {
    name: "integration gitlab projects",
    stdin: "list-token-0123456789abcdef\n",
    steps: [
      ["integration", "gitlab", "projects", "--base-url", "https://gitlab.example.com", "--access-token", "-", "--json"],
      ["integration", "gitlab", "projects", "--base-url", "https://gitlab.example.com", "--access-token", "-", "--human"],
    ],
  },
  {
    name: "integration gitlab update",
    seed: { gitlabIntegrations: GITLAB },
    steps: [
      ["integration", "gitlab", "update", "--active=false", "--comment-task-link=false", "--json"],
      ["integration", "gitlab", "get", "--human"],
      ["integration", "gitlab", "update", "--active", "--json"],
      ["integration", "gitlab", "import", "--human"],
    ],
  },
  {
    name: "integration gitlab update needs a change",
    seed: { gitlabIntegrations: GITLAB },
    steps: [
      ["integration", "gitlab", "update", "--json"],
      ["integration", "gitlab", "update", "--active=false", "--comment-task-link=false", "--json"],
    ],
  },
  {
    name: "integration gitlab update without a link",
    steps: [["integration", "gitlab", "update", "--active=false", "--json"]],
  },
  {
    name: "integration gitlab rm needs --yes and a link",
    seed: { gitlabIntegrations: GITLAB },
    steps: [
      ["integration", "gitlab", "rm", "--human"],
      ["integration", "gitlab", "rm", "--yes", "--json"],
      ["integration", "gitlab", "delete", "--yes", "--human"],
    ],
  },
  {
    name: "integration gitlab import without a link",
    steps: [["integration", "gitlab", "import", "--human"]],
  },
  {
    name: "integration gitlab import partial errors",
    seed: { gitlabIntegrations: GITLAB },
    gitlabImportErrors: ["Issue !12: the assignee is gone", "Merge request !34: labels refused"],
    steps: [["integration", "gitlab", "import", "--human"], ["integration", "gitlab", "import", "--json"]],
  },
  {
    name: "integration gitlab import an inactive link",
    seed: { gitlabIntegrations: [{ ...GITLAB[0]!, isActive: false }] },
    steps: [["integration", "gitlab", "import", "--human"]],
  },
  {
    // A plain member reads the link with its secrets withheld, is refused
    // every manage_settings route, and can still import: that route asks for
    // task permissions instead.
    name: "integration gitlab as a plain member",
    plainMember: true,
    seed: { gitlabIntegrations: GITLAB },
    stdin: "member-token-0123456789abcdef\n",
    steps: [
      ["integration", "gitlab", "get", "--human"],
      ["integration", "gitlab", "connect", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--human"],
      ["integration", "gitlab", "update", "--active=false", "--human"],
      ["integration", "gitlab", "rm", "--yes", "--human"],
      ["integration", "gitlab", "verify", "--base-url", "https://gitlab.example.com", "--project-path", "acme/web-app", "--access-token", "-", "--human"],
      ["integration", "gitlab", "projects", "--base-url", "https://gitlab.example.com", "--access-token", "-", "--human"],
      ["integration", "gitlab", "import", "--human"],
    ],
  },

  // ---- GitHub integration ----
  // app-info is the one route that answers an API key on every release; the
  // repositories, verify and connect routes need a user session and refuse
  // the key with the server's own words, which is the answer goldened.
  ...both("integration github app-info", ["integration", "github", "app-info"]),
  ...both("integration github repos needs a session", ["integration", "github", "repos"]),
  {
    // The page cursor is recorded with the refused request, so the golden
    // shows the query the CLI would have sent.
    name: "integration github repos pages",
    steps: [["integration", "github", "repos", "--installation-page", "2", "--repository-page", "3", "--json"]],
  },
  ...both("integration github verify needs a session", ["integration", "github", "verify", "acme", "kaneo"]),
  ...both("integration github connect needs a session", ["integration", "github", "connect", "acme", "kaneo"]),
  {
    // The session refusal runs before the project is placed, so a project
    // that does not exist gets it rather than a lookup.
    name: "integration github repos unknown project",
    steps: [["integration", "github", "repos", "-p", "nope", "--json"]],
  },
  {
    name: "integration github get without one",
    steps: [
      ["integration", "github", "get", "--json"],
      ["integration", "github", "get", "-p", "BET", "--json"],
      ["integration", "github", "get", "--human"],
    ],
  },
  {
    name: "integration github get",
    seed: {
      githubIntegrations: [
        { projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo", branchPattern: "feature/{slug}-{number}", commentTaskLinkOnGitHubIssue: false },
      ],
    },
    steps: [["integration", "github", "get", "--json"], ["integration", "github", "get", "--human"]],
  },
  {
    // An unverified binding reads as requiring verification and folds into
    // isActive, the way get-github-integration.ts answers it.
    name: "integration github get unverified",
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo", verified: false }] },
    steps: [["integration", "github", "get", "--json"]],
  },
  {
    name: "integration github update",
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo" }] },
    steps: [
      ["integration", "github", "update", "--active=false", "--comment-task-link=false", "--json"],
      ["integration", "github", "get", "--human"],
    ],
  },
  {
    name: "integration github update nothing",
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo" }] },
    steps: [["integration", "github", "update", "--json"]],
  },
  {
    // The route's own not-found shape is not the error envelope, so what the
    // failure prints is the server's words either way.
    name: "integration github update without one",
    steps: [["integration", "github", "update", "--active=false", "--json"]],
  },
  {
    // manage_settings is what update and rm ask; a member without it is
    // refused there while the read asks only for membership and answers.
    name: "integration github member reads but cannot write",
    plainMember: true,
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo" }] },
    steps: [
      ["integration", "github", "get", "--json"],
      ["integration", "github", "update", "--active=false", "--json"],
      ["integration", "github", "rm", "--yes", "--json"],
    ],
  },
  {
    name: "integration github rm",
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo" }] },
    steps: [
      ["integration", "github", "rm", "--json"],
      ["integration", "github", "rm", "--yes", "--json"],
      ["integration", "github", "get", "--human"],
    ],
  },
  { name: "integration github rm without one", steps: [["integration", "github", "rm", "--yes", "--json"]] },
  {
    // Five provider pages: the first request works four and answers 202, the
    // second continues the named run and finishes with 200. Repeating the
    // finished runId then answers the saved progress without new pages.
    name: "integration github import",
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo", importPages: 5 }] },
    steps: [
      ["integration", "github", "import", "--json"],
      ["integration", "github", "import", "--run-id", "run-0001", "--json"],
      ["integration", "github", "get", "--human"],
    ],
  },
  {
    // A slug goes through the lookup the way every project reference does:
    // the first request carries it, the 404 sends the lookup, and the retry
    // carries the id.
    name: "integration github import by slug",
    env: { KANEO_PROJECT: "ALP" },
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo", importPages: 1 }] },
    steps: [["integration", "github", "import", "--json"]],
  },
  {
    name: "integration github import paused",
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo", isActive: false }] },
    steps: [["integration", "github", "import", "--json"]],
  },
  {
    name: "integration github import unverified",
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo", verified: false }] },
    steps: [["integration", "github", "import", "--json"]],
  },
  {
    // A null installationId is the row with no installation bound: the verified
    // flag alone does not bind it, so get reports requiresVerification and
    // import refuses the way verified:false does. The seed must keep the null
    // rather than default it, or this state cannot be reproduced.
    name: "integration github no installation",
    seed: {
      githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo", installationId: null, verified: true }],
    },
    steps: [
      ["integration", "github", "get", "--json"],
      ["integration", "github", "import", "--json"],
    ],
  },
  { name: "integration github import without one", steps: [["integration", "github", "import", "--json"]] },
  {
    // A runId the server never issued is the 409 the route reserves for a
    // changed or unknown run.
    name: "integration github import unknown run",
    seed: { githubIntegrations: [{ projectId: P1, repositoryOwner: "acme", repositoryName: "kaneo", importPages: 1 }] },
    steps: [["integration", "github", "import", "--run-id", "run-9999", "--json"]],
  },
  {
    name: "integration github bad input",
    steps: [
      ["integration", "github", "repos", "--installation-page", "0"],
      ["integration", "github", "repos", "--repository-page", "1000000"],
      ["integration", "github", "verify", "acme"],
      ["integration", "github", "verify", " ", "kaneo"],
      ["integration", "github", "import", "--run-id", ""],
      ["integration", "bogus"],
      ["integration"],
      ["integration", "github"],
    ],
  },

  // A project's integrations live one per type: Mattermost posts task events to
  // a channel webhook, the generic webhook POSTs them signed. `set` creates
  // what is missing and patches what is there, `get` answers nothing-configured
  // for a project with none, and `rm` removes it once --yes confirms. The URL
  // and the secret are credentials `-` alone reads from stdin, so the request
  // bodies the goldens record show the sparse PATCH the flags add up to — a
  // URL rotation that touches nothing else included.
  ...both("integration mattermost get empty", ["integration", "mattermost", "get"]),
  {
    name: "integration mattermost set create update remove",
    stdin: "https://example.com/mm-alpha\n",
    steps: [
      ["integration", "mattermost", "set", WF, "-", "--channel-name", "alerts", "--task-comment-created=false", "--human"],
      ["integration", "mattermost", "get", "--json"],
      // The channel is cleared by an empty value, one toggle merges into the
      // stored set, and pausing is an explicit false.
      ["integration", "mattermost", "set", "--channel-name", "", "--task-status-changed", "--active=false", "--json"],
      ["integration", "mattermost", "get", "--human"],
      // Another project has no integration of its own.
      ["integration", "mattermost", "get", "-p", "proj-beta", "--json"],
      // rm reads the row first: without --yes it refuses, with it the row goes,
      // and a second rm finds nothing to remove.
      ["integration", "mattermost", "rm", "--json"],
      ["integration", "mattermost", "rm", "--yes", "--human"],
      ["integration", "mattermost", "get", "--json"],
      ["integration", "mattermost", "rm", "--yes", "--json"],
    ],
  },
  {
    name: "integration mattermost set rules",
    stdin: "https://example.com/mm-beta\n",
    steps: [
      // Creating needs the URL over stdin; --active does not apply to a new
      // integration; a second set with no flags has nothing to send; the
      // update routes cannot clear the URL; and a credential is never a value.
      ["integration", "mattermost", "set", "--channel-name", "alerts", "--json"],
      ["integration", "mattermost", "set", WF, "-", "--active=false", "--json"],
      ["integration", "mattermost", "set", WF, "-", "--json"],
      ["integration", "mattermost", "set", "--json"],
      ["integration", "mattermost", "set", WF, "", "--json"],
      ["integration", "mattermost", "set", WF, "https://example.com/mm-lit", "--json"],
      ["integration", "mattermost", "get", "--human"],
    ],
  },
  {
    name: "integration mattermost url rotation",
    seed: {
      integrations: [{ projectId: P1, provider: "mattermost", webhookUrl: "https://example.com/mm-old", channelName: "alerts", isActive: false }],
    },
    stdin: "https://example.com/mm-new\n",
    steps: [
      // The PATCH carries the URL alone: channel, events and active keep theirs.
      ["integration", "mattermost", "set", WF, "-", "--json"],
      ["integration", "mattermost", "get", "--human"],
    ],
  },
  {
    // isActive null is a row the server never set it on, which reads unset.
    name: "integration seeded get",
    seed: {
      integrations: [
        { projectId: P1, provider: "mattermost", webhookUrl: "https://example.com/mm-seeded", isActive: null },
        { projectId: P1, provider: "webhook", webhookUrl: "https://example.com/wh-seeded", secret: "whsec_seed_12", isActive: null, dueDateReminderLeadTimeMinutes: 90 },
      ],
    },
    steps: [
      ["integration", "mattermost", "get", "--human"],
      ["integration", "webhook", "get", "--human"],
      // The plural is the same command.
      ["integrations", "webhook", "get", "--json"],
    ],
  },
  {
    name: "integration mattermost url from stdin",
    stdin: "https://example.com/mm-stdin\n",
    steps: [["integration", "mattermost", "set", WF, "-", "--json"], ["integration", "mattermost", "get", "--human"]],
  },
  ...both("integration webhook get empty", ["integration", "webhook", "get"]),
  {
    name: "integration webhook set create update remove",
    stdin: "https://example.com/wh-alpha\n",
    steps: [
      ["integration", "webhook", "set", WF, "-", "--task-deleted", "--reminder-lead", "2h", "--json"],
      ["integration", "webhook", "get", "--human"],
      // Toggles merge and pausing is an explicit false; the signing secret is
      // a credential a create cannot carry beside the URL's one stdin, so it
      // is set by the update that follows in its own scenario.
      ["integration", "webhook", "set", "--task-moved=false", "--active=false", "--json"],
      ["integration", "webhook", "get", "--json"],
      ["integration", "webhook", "rm", "--json"],
      ["integration", "webhook", "rm", "--yes", "--human"],
      ["integration", "webhook", "get", "--json"],
      ["integration", "webhook", "rm", "--yes", "--json"],
    ],
  },
  {
    // --active does not apply to a new integration: it is created active, so
    // the flag is refused on the create path the way the chat providers do.
    name: "integration webhook create refuses active",
    stdin: "https://example.com/wh-paused\n",
    steps: [
      ["integration", "webhook", "set", WF, "-", "--active=false", "--json"],
      ["integration", "webhook", "set", WF, "-", "--active", "--json"],
      ["integration", "webhook", "get", "--json"],
    ],
  },
  {
    name: "integration webhook reminder lead bounds",
    stdin: "https://example.com/wh-lead\n",
    steps: [
      // The lead is whole minutes, 5 through 30 days (720h); a fraction and an
      // out-of-range value are refused before anything is stored.
      ["integration", "webhook", "set", WF, "-", "--reminder-lead", "90s", "--json"],
      ["integration", "webhook", "set", WF, "-", "--reminder-lead", "4m", "--json"],
      ["integration", "webhook", "set", WF, "-", "--reminder-lead", "720h", "--json"],
      ["integration", "webhook", "set", "--reminder-lead", "721h", "--json"],
      ["integration", "webhook", "get", "--json"],
    ],
  },
  {
    name: "integration webhook url from stdin",
    stdin: "https://example.com/wh-stdin\n",
    steps: [["integration", "webhook", "set", WF, "-", "--json"], ["integration", "webhook", "get", "--human"]],
  },
  {
    // stdin is per-scenario, so the secret's own pipe gets its own scenario;
    // the clear that follows needs no pipe, '' being the update schema's null.
    name: "integration webhook secret from stdin",
    seed: { integrations: [{ projectId: P1, provider: "webhook", webhookUrl: "https://example.com/wh-signed" }] },
    stdin: "whsec_piped_21\n",
    steps: [
      ["integration", "webhook", "set", SF, "-", "--json"],
      ["integration", "webhook", "get", "--human"],
      ["integration", "webhook", "set", SF, "", "--json"],
      ["integration", "webhook", "get", "--json"],
    ],
  },
  {
    name: "integration webhook url rotation",
    seed: {
      integrations: [
        {
          projectId: P1,
          provider: "webhook",
          webhookUrl: "https://example.com/wh-old",
          secret: "whsec_rot_13",
          events: { taskDeleted: true, taskCreated: false },
          dueDateReminderLeadTimeMinutes: 90,
          isActive: false,
        },
      ],
    },
    stdin: "https://example.com/wh-new\n",
    steps: [
      // The PATCH carries the URL alone: the secret, the toggles, the lead and
      // the paused state all keep theirs.
      ["integration", "webhook", "set", WF, "-", "--json"],
      ["integration", "webhook", "get", "--human"],
    ],
  },
  {
    name: "integration webhook two stdin flags refused",
    stdin: "unused\n",
    steps: [["integration", "webhook", "set", WF, "-", SF, "-", "--json"]],
  },
  {
    name: "integration webhook empty stdin refused",
    seed: { integrations: [{ projectId: P1, provider: "webhook", webhookUrl: "https://example.com/wh-empty" }] },
    stdin: "\n",
    steps: [
      ["integration", "webhook", "set", WF, "-", "--json"],
      ["integration", "webhook", "set", SF, "-", "--json"],
    ],
  },
  {
    name: "integration webhook credentials refuse literals",
    steps: [
      ["integration", "webhook", "set", WF, "https://example.com/wh-lit", "--json"],
      ["integration", "webhook", "set", SF, "whsec_literal_14", "--json"],
    ],
  },
  {
    // The API validates the Mattermost URL itself: http is refused with a
    // text/plain 400 and nothing is stored.
    name: "integration mattermost url scheme refused",
    stdin: "http://insecure.example/mm\n",
    steps: [
      ["integration", "mattermost", "set", WF, "-", "--json"],
      ["integration", "mattermost", "get", "--json"],
    ],
  },
  {
    // A refused PATCH writes nothing: the stored row still has the old URL.
    name: "integration mattermost patch scheme refused keeps stored",
    seed: {
      integrations: [{ projectId: P1, provider: "mattermost", webhookUrl: "https://example.com/mm-kept", channelName: "alerts" }],
    },
    stdin: "http://insecure.example/mm\n",
    steps: [
      ["integration", "mattermost", "set", WF, "-", "--json"],
      ["integration", "mattermost", "get", "--human"],
    ],
  },
  {
    name: "integration mattermost url from file",
    files: { "mm-url.txt": "https://example.com/mm-file\n" },
    steps: [
      ["integration", "mattermost", "set", WF_FILE, "mm-url.txt", "--json"],
      ["integration", "mattermost", "get", "--human"],
      // rm takes the project by slug here, as -p does everywhere.
      ["integration", "mattermost", "rm", "-p", "ALP", "--yes", "--json"],
      ["integration", "mattermost", "get", "--json"],
    ],
  },
  {
    // The URL on stdin (CRLF included) and the secret in a file fit one
    // create: the POST carries both, so the webhook is signed from its first
    // delivery. The file flag works on update alone, a multi-line file keeps
    // its lines, and the two input modes for one credential refuse together.
    name: "integration webhook signed create in one call",
    stdin: "https://example.com/wh-filed\r\n",
    files: {
      "whsec.txt": "whsec_from_file_9\n",
      "whsec-next.txt": "whsec_next_4\n",
      "whsec-lines.txt": "whsec_multi\nline_2\n",
      "whsec-empty.txt": "",
      "whurl.txt": "https://example.com/wh-urlfile\n",
    },
    steps: [
      ["integration", "webhook", "set", WF, "-", SF_FILE, "whsec.txt", "--json"],
      ["integration", "webhook", "get", "--human"],
      ["integration", "webhook", "set", SF_FILE, "whsec-next.txt", "--json"],
      ["integration", "webhook", "set", SF_FILE, "whsec-lines.txt", "--json"],
      ["integration", "webhook", "get", "--json"],
      ["integration", "webhook", "set", SF, "", SF_FILE, "whsec.txt", "--json"],
      ["integration", "webhook", "set", SF_FILE, "nope.txt", "--json"],
      ["integration", "webhook", "set", SF_FILE, "whsec-empty.txt", "--json"],
      ["integration", "webhook", "get", "--json"],
      // Beta has no integration, so this is a second one-call create with
      // both credentials from files, the project named by slug.
      ["integration", "webhook", "set", WF_FILE, "whurl.txt", SF_FILE, "whsec.txt", "-p", "BET", "--json"],
      ["integration", "webhook", "get", "-p", "BET", "--json"],
    ],
  },
  {
    // A plain member still reads the integration — GET asks only for
    // workspace access — but every write is refused: upstream's manageAccess
    // gates POST, PATCH and DELETE on manage_settings.
    name: "integration mattermost as a plain member",
    plainMember: true,
    seed: {
      integrations: [{ projectId: P1, provider: "mattermost", webhookUrl: "https://example.com/mm-member", channelName: "alerts" }],
    },
    stdin: "https://example.com/mm-member-new\n",
    steps: [
      ["integration", "mattermost", "get", "--human"],
      // PATCH on the seeded row, POST on Beta's empty project, and DELETE.
      ["integration", "mattermost", "set", WF, "-", "--json"],
      ["integration", "mattermost", "set", WF, "-", "-p", "BET", "--json"],
      ["integration", "mattermost", "set", "--active=false", "--json"],
      ["integration", "mattermost", "rm", "--yes", "--json"],
    ],
  },
  {
    name: "integration webhook as a plain member",
    plainMember: true,
    seed: {
      integrations: [{ projectId: P1, provider: "webhook", webhookUrl: "https://example.com/wh-member", secret: "whsec_member_3" }],
    },
    stdin: "https://example.com/wh-member-new\n",
    steps: [
      ["integration", "webhook", "get", "--human"],
      ["integration", "webhook", "set", WF, "-", "--json"],
      ["integration", "webhook", "set", "--active=false", "--json"],
      ["integration", "webhook", "rm", "--yes", "--json"],
      // Beta has no webhook integration, so its create is refused too.
      ["integration", "webhook", "set", WF, "-", "-p", "BET", "--json"],
    ],
  },

  // ===== Instance, public boards, session, assets and avatars =====

  ...both("instance status", ["instance", "status"]),
  ...both("instance config", ["instance", "config"]),
  {
    // The routes are security: [], so no key, workspace or project is needed.
    name: "instance reads without a key",
    env: { KANEO_API_KEY: "", KANEO_PROJECT: "", KANEO_WORKSPACE: "" },
    steps: [["instance", "status", "--human"], ["instance", "config", "--json"]],
  },
  ...both("whoami session", ["whoami", "session"]),
  {
    // set stores the image, get reads it back — to stdout and to --out —
    // byte for byte, rm takes it away, and rm again reports there was
    // nothing left.
    name: "whoami avatar set, get and rm",
    files: {
      // The PNG signature followed by bytes no text decode survives, the
      // same payload asset-bin seeds: what the fake stores must be what the
      // GET serves, so a fake that kept the upload as text would show here.
      "face.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]),
    },
    steps: [
      ["whoami", "avatar", "set", "face.png", "--json"],
      ["avatar", "get", "avatar-self", "--human"],
      ["avatar", "get", "avatar-self", "--out", "round.png", "--json"],
      ["whoami", "avatar", "rm", "--human"],
      ["whoami", "avatar", "rm", "--json"],
      // The avatar is gone, so both reads fail — --out still reports the 404
      // as JSON, while the raw stdout path keeps it off stdout entirely.
      ["avatar", "get", "avatar-self", "--out", "gone.webp", "--json"],
      ["avatar", "get", "avatar-self", "--human"],
    ],
  },
  {
    name: "whoami avatar set refuses what is not an image",
    files: { "notes.txt": "text", "empty.png": "" },
    steps: [
      ["whoami", "avatar", "set", "notes.txt", "--json"],
      ["whoami", "avatar", "set", "empty.png", "--json"],
      ["whoami", "avatar", "set", "missing.png", "--json"],
    ],
  },
  {
    name: "avatar get",
    env: { KANEO_API_KEY: "" },
    seed: {
      avatars: [
        { id: "av-1", body: "avatar-one-bytes", contentType: "image/webp" },
        // UTF-8 with a leading BOM: the recording decoder keeps it as U+FEFF,
        // so these bytes record differently from "hi" alone would.
        { id: "av-bom", body: new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), contentType: "image/webp" },
        // Not UTF-8: recorded as {"base64": ...}, the shape no text takes.
        { id: "av-bin", body: new Uint8Array([0xff]), contentType: "image/webp" },
        // Text that reads like a binary record stays the string it is.
        { id: "av-marker", body: "base64:/w==", contentType: "image/webp" },
      ],
    },
    steps: [
      ["avatar", "get", "av-1", "--human"],
      // The bytes have no JSON form, so the output flags are refused on the
      // stdout path — before any request is made.
      ["avatar", "get", "av-1", "--json"],
      ["avatar", "get", "av-1", "--jq", "."],
      ["avatar", "get", "av-1", "--out", "face.webp", "--json"],
      // av-bom's bytes are UTF-8 behind a BOM, av-bin's are not UTF-8 at
      // all, and av-marker's text is what a binary record looks like — the
      // three must record three different ways.
      ["avatar", "get", "av-bom", "--human"],
      ["avatar", "get", "av-bin", "--human"],
      ["avatar", "get", "av-marker", "--human"],
      // A missing avatar still fails the read — --out reports the 404 as
      // JSON, while the raw stdout path keeps it off stdout entirely.
      ["avatar", "get", "nope", "--out", "none.webp", "--json"],
      ["avatar", "get", "nope", "--human"],
    ],
  },
  {
    name: "asset get",
    seed: {
      assets: [
        { id: "asset-pic", body: "fake-asset-bytes", contentType: "image/png" },
        { id: "asset-priv", body: "private-asset-bytes", contentType: "text/plain", public: false },
        // Not UTF-8: the PNG signature followed by bytes no text decode
        // survives, so the goldens pin that the download's bytes — to stdout
        // or to --out — arrive as they were served, not as text would.
        { id: "asset-bin", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]), contentType: "image/png" },
      ],
    },
    steps: [
      ["asset", "get", "asset-pic", "--human"],
      // The bytes have no JSON form, so the output flags are refused on the
      // stdout path — before any request is made.
      ["asset", "get", "asset-pic", "--json"],
      ["asset", "get", "asset-pic", "--jq", "."],
      ["asset", "get", "asset-bin", "--human"],
      ["asset", "get", "asset-bin", "--out", "bin.png", "--json"],
      ["asset", "get", "asset-priv", "--human"],
      // A missing asset still fails the read — --out reports the 404 as
      // JSON, while the raw stdout path keeps it off stdout entirely.
      ["asset", "get", "missing", "--out", "missing.bin", "--json"],
      ["asset", "get", "missing", "--human"],
    ],
  },
  {
    // A public asset answers without a key; a private one is refused.
    name: "asset get without a key",
    env: { KANEO_API_KEY: "" },
    seed: {
      assets: [
        { id: "asset-pic", body: "fake-asset-bytes", contentType: "image/png" },
        { id: "asset-priv", body: "private-asset-bytes", contentType: "text/plain", public: false },
      ],
    },
    steps: [
      ["asset", "get", "asset-pic", "--human"],
      // --out keeps --json meaningful on a refused read: the 401 is reported
      // as the usual error document.
      ["asset", "get", "asset-priv", "--out", "priv.bin", "--json"],
    ],
  },
  {
    name: "public project",
    seed: {
      projects: [
        ...SEED.projects,
        { id: "proj-public", workspaceId: WS, name: "Public", slug: "PUB", isPublic: true, description: "shared board ".repeat(90) },
      ],
    },
    // The three tasks differ on every field the filters read, so the filtered
    // read answers with task-pub1 alone.
    extraTasks: [
      { id: "task-pub1", projectId: "proj-public", title: "Public first", priority: "high", userId: "user-1", dueDate: "2026-01-10T00:00:00.000Z" },
      { id: "task-pub2", projectId: "proj-public", title: "Public second", status: "done", priority: "low", userId: "user-2", dueDate: "2026-03-10T00:00:00.000Z" },
      { id: "task-pub3", projectId: "proj-public", title: "Public third", status: "archived" },
    ],
    steps: [
      ["public", "project", "proj-public", "--human"],
      ["public", "project", "proj-public", "--status", "to-do", "--json"],
      ["public", "project", "proj-public", "--sort-by", "title", "--sort-order", "desc", "--limit", "1", "--json"],
      ["public", "project", "proj-public", "--priority", "high", "--assignee-id", "user-1", "--due-before", "2026-02-01T00:00:00.000Z", "--due-after", "2026-01-01T00:00:00.000Z", "--json"],
      ["public", "project", "proj-alpha", "--json"],
      ["public", "project", "proj-public", "--sort-by", "sideways", "--json"],
    ],
  },
  {
    name: "public reads without a key",
    env: { KANEO_API_KEY: "", KANEO_PROJECT: "", KANEO_WORKSPACE: "" },
    seed: {
      projects: [
        ...SEED.projects,
        { id: "proj-public", workspaceId: WS, name: "Public", slug: "PUB", isPublic: true, description: "shared board ".repeat(90) },
      ],
    },
    extraTasks: [{ id: "task-pub1", projectId: "proj-public", title: "Public first" }],
    steps: [["public", "project", "proj-public", "--human"], ["public", "description", "proj-public", "--json"]],
  },
  {
    // The project description pages at 1024 characters a page; the task's by
    // id, by number, and the misses.
    name: "public description",
    seed: {
      projects: [
        ...SEED.projects,
        { id: "proj-public", workspaceId: WS, name: "Public", slug: "PUB", isPublic: true, description: "shared board ".repeat(90) },
      ],
    },
    extraTasks: [
      { id: "task-pub1", projectId: "proj-public", title: "Public first" },
      { id: "task-pub2", projectId: "proj-public", title: "Public second", description: "task detail ".repeat(200) },
    ],
    steps: [
      ["public", "description", "proj-public", "--human"],
      ["public", "description", "proj-public", "task-pub2", "--json"],
      ["public", "description", "proj-public", "2", "--human"],
      ["public", "description", "proj-public", "99", "--json"],
      ["public", "description", "proj-alpha", "--json"],
    ],
  },

  {
    name: "integration get with none set",
    steps: [
      ["integration", "slack", "get", "--json"],
      ["integration", "slack", "get", "--human"],
      ["integration", "discord", "get", "--json"],
      ["integration", "telegram", "get", "--human"],
      ["integration", "jabber", "get", "--json"],
    ],
  },
  // Chat integrations: slack and discord post through a webhook URL, telegram
  // through a bot token. The secrets only ever arrive on stdin — a `-` flag
  // value — so the scenarios that create or rotate one carry it as stdin.
  {
    name: "integration slack set, update and rm",
    stdin: "https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnop\n",
    steps: [
      ["integration", "slack", "get", "--json"],
      // A new integration is always created active, so --active is refused.
      ["integration", "slack", "set", WEBHOOK_URL_FLAG, "-", "--active", "--json"],
      ["integration", "slack", "set", WEBHOOK_URL_FLAG, "-", "--channel-name", "alerts", "--json"],
      ["integration", "slack", "get", "--human"],
      // Rotating the webhook reads the secret from stdin again.
      ["integration", "slack", "set", WEBHOOK_URL_FLAG, "-", "--json"],
      ["integration", "slack", "set", "--channel-name", "", "--task-priority-changed", "--active=false", "--json"],
      ["integration", "slack", "set", "--json"],
      ["integration", "slack", "rm", "--json"],
      ["integration", "slack", "rm", "--yes", "--human"],
      ["integration", "slack", "rm", "--yes", "--json"],
      ["integration", "slack", "get", "--json"],
    ],
  },
  {
    name: "integration discord set, rotate and rm",
    stdin: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789\n",
    steps: [
      ["integration", "discord", "set", WEBHOOK_URL_FLAG, "-", "--channel-name", "general", "--task-created=false", "--json"],
      ["integration", "discord", "get", "--human"],
      ["integration", "discord", "set", WEBHOOK_URL_FLAG, "-", "--json"],
      ["integration", "discord", "set", "--channel-name", "alerts", "--task-title-changed", "--active=false", "--human"],
      ["integration", "discord", "delete", "--yes", "--json"],
      ["integration", "discord", "get", "--json"],
    ],
  },
  {
    name: "integration telegram set, update and rm",
    stdin: "123456789:abcdefghijklmnopqrstuvwxyz012345678\n",
    steps: [
      ["integration", "telegram", "get", "--json"],
      // The chat id is required on create, checked after the token is read.
      ["integration", "telegram", "set", "--bot-token", "-", "--json"],
      ["integration", "telegram", "set", "--bot-token", "-", "--chat-id", "123456789", "--chat-label", "ops alerts", "--thread-id", "42", "--json"],
      ["integration", "telegram", "get", "--human"],
      ["integration", "telegram", "set", "--chat-id", "-1001234567890", "--thread-id", "", "--chat-label", "", "--task-comment-created=false", "--active=false", "--json"],
      // --thread-id takes a decimal integer of at least 1; other spellings
      // are refused before the write goes out.
      ["integration", "telegram", "set", "--thread-id", "abc", "--json"],
      ["integration", "telegram", "set", "--thread-id", "0", "--json"],
      ["integration", "telegram", "set", "--thread-id", "-1", "--json"],
      ["integration", "telegram", "set", "--thread-id", "0x10", "--json"],
      ["integration", "telegram", "set", "--thread-id", "1e3", "--json"],
      ["integration", "telegram", "set", "--thread-id", " ", "--json"],
      // The same token changes nothing, so the server answers without a write.
      ["integration", "telegram", "set", "--bot-token", "-", "--json"],
      ["integration", "telegram", "set", "--json"],
      ["integration", "telegram", "rm", "--yes", "--json"],
      ["integration", "telegram", "get", "--human"],
    ],
  },
  {
    name: "integration seeded on two projects",
    seed: {
      integrations: [
        { projectId: P1, provider: "slack", webhookUrl: "https://hooks.slack.com/services/T11111111/B22222222/seededseededseed99", channelName: "seeded", isActive: null },
        { projectId: P1, provider: "discord", webhookUrl: "https://discordapp.com/api/webhooks/555444333/seedDiscordWebhookValue1234567890", events: { taskCreated: false } },
        { projectId: P1, provider: "telegram", botToken: "987654321:qwertyuiopasdfghjklzxcvbnm123456789", chatId: "-100987654321", threadId: 7, chatLabel: " seeded ops ", isActive: false },
        { projectId: "proj-beta", provider: "slack", webhookUrl: "https://hooks.slack.com/services/T33333333/B44444444/betaprojectvalue123" },
      ],
    },
    steps: [
      ["integration", "slack", "get", "--human"],
      ["integration", "discord", "get", "--json"],
      ["integration", "telegram", "get", "--human"],
      ["integration", "slack", "get", "-p", "proj-beta", "--json"],
      ["integration", "telegram", "get", "-p", "proj-beta", "--json"],
      ["integration", "telegram", "rm", "--yes", "--json"],
      ["integration", "telegram", "get", "--json"],
    ],
  },
  {
    // The same garbage stdin is refused by all three providers' shape checks.
    name: "integration refuses malformed secrets",
    stdin: "not a url\n",
    steps: [
      ["integration", "slack", "set", WEBHOOK_URL_FLAG, "-", "--json"],
      ["integration", "discord", "set", WEBHOOK_URL_FLAG, "-", "--json"],
      ["integration", "telegram", "set", "--bot-token", "-", "--chat-id", "123", "--json"],
    ],
  },
  {
    // Whitespace alone is no credential: a webhook URL of spaces would trim
    // to the stored one on update and a bot token of them fails the server's
    // shape check, so the CLI refuses it before the write goes out — on the
    // create path for two providers and the update path for the third.
    name: "integration secrets refuse whitespace-only stdin",
    seed: { integrations: [{ projectId: P1, provider: "slack", webhookUrl: "https://hooks.slack.com/services/T99999999/B00000000/keptsecretvalue000" }] },
    stdin: "   \n",
    steps: [
      ["integration", "discord", "set", WEBHOOK_URL_FLAG, "-", "--json"],
      ["integration", "telegram", "set", "--bot-token", "-", "--chat-id", "123", "--json"],
      ["integration", "slack", "set", WEBHOOK_URL_FLAG, "-", "--json"],
    ],
  },
  {
    name: "integration discord refuses a webhook off the discord hosts",
    stdin: "https://example.com/api/webhooks/1/tok\n",
    steps: [["integration", "discord", "set", WEBHOOK_URL_FLAG, "-", "--json"]],
  },
  {
    name: "integration secrets stay off the command line",
    stdin: "",
    steps: [
      ["integration", "slack", "set", "--json"],
      ["integration", "telegram", "set", "--chat-id", "1", "--json"],
      ["integration", "slack", "set", WEBHOOK_URL_FLAG, "https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnop", "--json"],
      ["integration", "telegram", "set", "--bot-token", "123456789:abcdefghijklmnopqrstuvwxyz012345678", "--chat-id", "1", "--json"],
      ["integration", "slack", "set", WEBHOOK_URL_FLAG, "-", "--json"],
      ["integration", "telegram", "set", "--bot-token", "-", "--chat-id", "1", "--json"],
    ],
  },
  {
    // -p takes an id, a slug or a name like every other project command: the
    // chat routes answer a slug the way they answer an unknown id, and the
    // project lookup turns it into the id before the write goes out. The
    // seeded rows leave isActive unset, so the patches also pin the server's
    // reading of it: an omitted --active resolves to on once a patch changes
    // something, while a patch that changes nothing keeps the stored null.
    name: "integration commands take a project slug or name",
    seed: {
      integrations: [
        { projectId: P1, provider: "slack", webhookUrl: "https://hooks.slack.com/services/T55555555/B66666666/sluglookupvalue99", isActive: null },
        { projectId: P2, provider: "telegram", botToken: "987654321:abcdefghijklmnopqrstuvwxyz012345678", chatId: "-100555444333", isActive: null },
      ],
    },
    stdin: "https://hooks.slack.com/services/T77777777/B88888888/namedlookupvalue888\n",
    steps: [
      ["integration", "slack", "get", "-p", "ALP", "--json"],
      // Rotating by slug patches only the fields passed; the unset isActive
      // resolves to on.
      ["integration", "slack", "set", "-p", "ALP", WEBHOOK_URL_FLAG, "-", "--json"],
      ["integration", "slack", "get", "-p", "ALP", "--human"],
      // proj-beta has no slack integration, so set posts a new one by slug.
      ["integration", "slack", "set", "-p", "BET", WEBHOOK_URL_FLAG, "-", "--channel-name", "beta-alerts", "--json"],
      ["integration", "telegram", "get", "-p", "Beta", "--json"],
      // The same chat id changes nothing: the server answers the stored row
      // — null isActive and all — without a write.
      ["integration", "telegram", "set", "-p", "Beta", "--chat-id", "-100555444333", "--json"],
      // A real change resolves the unset isActive to on.
      ["integration", "telegram", "set", "-p", "Beta", "--chat-label", "beta ops", "--json"],
      ["integration", "telegram", "rm", "-p", "BET", "--yes", "--json"],
      ["integration", "telegram", "get", "-p", "BET", "--json"],
    ],
  },
];

