import { KaneoApiError } from "../api/http";
import { lastTaskNumbers, listProjectsIn, listWorkspaces, type Project, type Workspace } from "../api/kaneo";

// Turning a value somebody typed into the id the API takes, so a slug or a name
// works wherever an id does. A slug is what people and agents type: it is the
// prefix of every task reference, as in `kaneo-cli#3`.

// A project with the workspace it lives in. Ids are unique across the server, but
// slugs and names are not — not even inside one workspace — so anything that
// reports a project found by one of those, or lists more than one workspace, has
// to say which workspace it is in.
export type ProjectIn = { project: Project; workspaceName: string };

// A workspace whose projects could not be listed, with what the server said.
export type Unlisted = { workspaceName: string; message: string };

// Every project the key can reach, each with the workspace it is in: one listing
// per workspace, all asked at once. Archived projects are left out unless asked
// for, which is the view every listing takes; a lookup asks for them, since an
// archived project is one somebody still has to be able to name to unarchive it.
//
// A workspace that refuses its listing (403, 5xx, a timeout) does not take the
// rest with it: the projects of the others are returned, and the ones that
// failed are returned beside them, because a caller that treats the list as
// complete would otherwise report a project missing that was only unreachable.
// Only the listing of the workspaces themselves has no partial answer.
export const allProjects = async (includeArchived: boolean): Promise<{ found: ProjectIn[]; unlisted: Unlisted[] }> => {
  const workspaces = await listWorkspaces();
  const listings = await Promise.all(
    workspaces.map(async (workspace) => {
      try {
        const projects = await listProjectsIn(workspace.id, includeArchived);
        return { workspace, projects, failure: undefined };
      } catch (e) {
        return { workspace, projects: [] as Project[], failure: (e as Error).message };
      }
    }),
  );
  const found: ProjectIn[] = [];
  const unlisted: Unlisted[] = [];
  for (const { workspace, projects, failure } of listings) {
    if (failure !== undefined) unlisted.push({ workspaceName: workspace.name, message: failure });
    for (const project of projects) found.push({ project, workspaceName: workspace.name });
  }
  return { found, unlisted };
};

// The sentence for workspaces that could not be listed, for a listing that went
// ahead without them and for a lookup that missed while they were out.
export const unlistedMessage = (unlisted: Unlisted[]): string =>
  unlisted.map((u) => `could not list the projects of workspace ${JSON.stringify(u.workspaceName)}: ${u.message}`).join("; ");

// Values already turned into an id in this run, so a command that names the same
// project twice (`board` reads the project, then its board) looks it up once.
const resolved = new Map<string, string>();

// Runs an operation against the project a value names, looking the value up only
// if the server does not know it as an id. The ordinary path, an id, costs no
// extra request.
//
// The retry is safe because the server refuses an unknown project before it
// writes anything: every op here either reads first or is a single request whose
// project the server checks before acting on it. A new op has to keep that true —
// its first request must be the one that carries the project.
// explain adds to the error when the value names no project; a caller that
// knows more about what the value was meant to be says it there.
export const withProject = async <T>(value: string, op: (id: string) => Promise<T>, explain?: () => Promise<string>): Promise<T> => {
  if (value === "") return op(value);
  const known = resolved.get(value);
  if (known !== undefined) return op(known);
  try {
    const result = await op(value);
    resolved.set(value, value);
    return result;
  } catch (e) {
    if (!unknownProject(e)) throw e;
    const everywhere = await lookingUp(e, () => allProjects(true));
    const found = projectsNamed(everywhere.found, value);
    // A miss proves nothing while a workspace could not be listed: the project
    // may be in it. Saying it does not exist would send the reader to look for
    // a typo that is not there.
    if (found.length === 0 && everywhere.unlisted.length > 0) {
      throw new Error(`${e.message}: ${noProject(value)} in the workspaces that could be listed; ${unlistedMessage(everywhere.unlisted)}`);
    }
    if (found.length === 0) throw new Error(`${e.message}: ${noProject(value)}${explain === undefined ? "" : await explain()}`);
    if (found.length > 1) throw new Error(severalProjects(value, found));
    const only = found[0]!.project;
    // The value already was this project's id and the request failed anyway, so
    // the server's own answer is the report.
    if (only.id === value) throw e;
    resolved.set(value, only.id);
    return op(only.id);
  }
};

// The workspace a value names, matched against the listing before anything is
// sent with it.
//
// A workspace cannot be tried as an id first the way a project is: the project
// listing answers 403 for one the key cannot reach, but an instance admin's key
// passes that check and gets 200 with an empty list, which would print as a
// workspace with no projects in it. The listing costs one small request, and
// holds only the workspaces the key's user is a member of, so an admin reaching
// another one has to go through the web app.
export const resolveWorkspace = async (value: string): Promise<string> => {
  const found = workspacesNamed(await listWorkspaces(), value);
  if (found.length === 0) throw new Error(noWorkspace(value));
  if (found.length > 1) throw new Error(severalWorkspaces(value, found));
  return found[0]!.id;
};

// A failure inside the lookup is reported next to the answer that started it,
// rather than in its place: the server's answer is the part that says which
// request failed.
const lookingUp = async <T>(cause: KaneoApiError, lookup: () => Promise<T>): Promise<T> => {
  try {
    return await lookup();
  } catch (e) {
    throw new Error(`${cause.message}; looking it up failed: ${(e as Error).message}`);
  }
};

// The complaint the server makes when a path names no project it can place. It
// is the server's own wording, and docs/glossary.md already records it as the
// answer to a value sent where an id was expected.
const NO_PLACE = "Workspace ID could not be determined";

// Whether a failure says the value named no project, rather than the server
// refusing the request for some other reason.
//
// A project in the path is checked before the route runs, and the server answers
// 400 with the complaint above when it cannot find it. A 400 is also what the
// server says about a body it will not accept, so the message decides. A project
// in a body (`task move`'s destination) is looked up by the route itself, which
// answers 404 `Project not found`.
//
// A 403 is a different answer — the key cannot reach the project — and a lookup
// would not change that.
const unknownProject = (e: unknown): e is KaneoApiError =>
  placesNothing(e) || (e instanceof KaneoApiError && e.statusCode === 404 && e.messages.includes("Project not found"));

// Whether the server could not place the id in the path in any workspace: it
// does not exist, or not in one the key reaches.
export const placesNothing = (e: unknown): e is KaneoApiError =>
  e instanceof KaneoApiError && e.statusCode === 400 && e.messages.includes(NO_PLACE);

// The projects a value names, by id, then by slug, then by name. An id is a
// case-sensitive key; a slug or a name is tried exactly before ignoring case.
//
// The steps are tried in turn rather than all at once, so a value that is an id
// and also spells somebody's slug is still read as the id it is, and `bet` picks
// the project whose slug is `bet` over one whose slug is `BET`.
const projectsNamed = (all: ProjectIn[], value: string): ProjectIn[] =>
  firstMatch(all, value, (p) => p.project.id, [(p) => p.project.slug, (p) => p.project.name]);

const workspacesNamed = (all: Workspace[], value: string): Workspace[] =>
  firstMatch(all, value, (w) => w.id, [(w) => w.slug, (w) => w.name]);

// Exported because a command outside this file matches the same reference the
// same way — `project reorder` names a project rather than being handed one —
// and a second copy of these rules would be a second answer to the same word.
export const firstMatch = <T>(all: T[], value: string, id: (item: T) => string, keys: ((item: T) => string)[]): T[] => {
  const byId = all.filter((item) => id(item) === value);
  if (byId.length > 0) return byId;
  const lower = value.toLowerCase();
  for (const key of keys) {
    const exact = all.filter((item) => key(item) === value);
    if (exact.length > 0) return exact;
    const folded = all.filter((item) => key(item).toLowerCase() === lower);
    if (folded.length > 0) return folded;
  }
  return [];
};

// What names a project in a message: its slug, or what stands in for one when
// the server holds an empty slug, so the message has no blank where the name
// should be.
export const slugOr = (slug: string, fallback: string): string => (slug === "" ? fallback : slug);

// For a task number whose project is named by a workspace's name, in a
// reference (`Private#6`) or by -p with a bare number: task numbers are per
// project, so it names no task until a project is chosen, and the projects that
// can hold #number are named. Read only on that failure path; any failure
// while working the hint out leaves the plain message.
export const workspaceInReference = async (value: string, number: number): Promise<string> => {
  try {
    const named = workspacesNamed(await listWorkspaces(), value);
    if (named.length !== 1) return "";
    const holding = (await lastTaskNumbers(named[0]!.id)).filter((p) => p.lastTaskNumber === null || p.lastTaskNumber >= number);
    const listed =
      holding.length === 0
        ? `no active project in it has reached #${number}`
        : `active projects in it that can hold #${number}: ${holding.map(({ project: p }) => `${slugOr(p.slug, p.id)} (${p.name})`).join(", ")}`;
    return `; ${JSON.stringify(value)} is a workspace, and task numbers are per project: ${listed}`;
  } catch {
    return "";
  }
};

const noProject = (value: string): string =>
  `no project has the id, slug or name ${JSON.stringify(value)} (kaneo project find <text> searches names and slugs)`;

const noWorkspace = (value: string): string =>
  `no workspace has the id, slug or name ${JSON.stringify(value)} (kaneo workspace ls lists them)`;

// Two projects can carry the same slug or name, and picking one of them would be
// a rule nobody stated, so they are all named and the id is what chooses.
const severalProjects = (value: string, found: ProjectIn[]): string =>
  `${JSON.stringify(value)} matches several projects: ${found
    .map((p) => `${p.project.slug === "" ? p.project.id : `${p.project.slug} (${p.project.id})`} in ${p.workspaceName}`)
    .join(", ")}; pass the id`;

const severalWorkspaces = (value: string, found: Workspace[]): string =>
  `${JSON.stringify(value)} matches several workspaces: ${found
    .map((w) => (w.slug === "" ? w.id : `${w.slug} (${w.id})`))
    .join(", ")}; pass the id`;
