import { KaneoApiError } from "../api/http";
import { listProjectsIn, listWorkspaces, type Project, type Workspace } from "../api/kaneo";
import type { App } from "./app";

// Turning a value somebody typed into the id the API takes.
//
// A project and a workspace are written down as ids everywhere this CLI reads
// them, so an id is tried first and the ordinary path costs no extra request.
// Only when the server says it does not know the value is it looked up across
// the workspaces the key can see. That is what lets a slug or a name work
// wherever an id does, and a slug is what people and agents type: it is the
// prefix of every task reference, as in `kaneo-cli#3`.

// A project with the workspace it lives in. Ids are unique inside a workspace
// but not across them, so anything that reports a project more than once — a
// listing across workspaces, an ambiguity, a lookup error — has to say which.
export type ProjectIn = { project: Project; workspaceName: string };

// Every project the key can reach, each with the workspace it is in.
//
// This is the widest request sequence in the CLI — one listing per workspace the
// key can see — so it takes the command's own deadline rather than leaving each
// request to be cut short on its own: a lookup that ran out of budget half way
// through would answer with a project missing from the list, which reads as
// "there is no such project".
//
// Archived projects are left out unless asked for, which is the view every
// listing takes, and `project find` asks for them because one that has been
// archived is a project somebody still has to be able to find.
export const allProjects = async (app: App, includeArchived: boolean): Promise<ProjectIn[]> => {
  const found: ProjectIn[] = [];
  for (const workspace of await listWorkspaces(app.deadline)) {
    for (const project of await listProjectsIn(workspace.id, includeArchived)) {
      found.push({ project, workspaceName: workspace.name });
    }
  }
  return found;
};

// Runs an operation against the project a value names, resolving it first if the
// server turns out not to know it.
//
// Only the first request of the operation can be the one retried, because the
// retry happens when that request fails and the rest of the operation has not
// run yet — so a write that already landed is never sent twice. `op` therefore
// takes the id rather than the value: whatever it requests first has to be the
// request that carries it.
export const withProject = async <T>(app: App, value: string, op: (id: string) => Promise<T>): Promise<T> => {
  try {
    return await op(value);
  } catch (e) {
    if (!unknownProject(e)) throw e;
    const found = projectsNamed(await allProjects(app, true), value);
    if (found.length === 0) throw new Error(`${(e as Error).message}: ${noProject(value)}`);
    if (found.length > 1) throw new Error(severalProjects(value, found));
    const only = found[0]!.project;
    // The value already was this project's id and the request failed anyway, so
    // there is nothing to retry with and the server's own message is the report.
    if (only.id === value) throw e;
    return op(only.id);
  }
};

// The same for a workspace.
export const withWorkspace = async <T>(
  app: App,
  value: string,
  op: (id: string) => Promise<T>,
): Promise<T> => {
  try {
    return await op(value);
  } catch (e) {
    if (!unknownWorkspace(e)) throw e;
    const found = workspacesNamed(await listWorkspaces(app.deadline), value);
    if (found.length === 0) throw new Error(`${(e as Error).message}: ${noWorkspace(value)}`);
    if (found.length > 1) throw new Error(severalWorkspaces(value, found));
    const only = found[0]!;
    if (only.id === value) throw e;
    return op(only.id);
  }
};

// The project a value names, looked up rather than tried as an id.
//
// A task reference of the form `<slug>#<number>` comes through here: the
// reference names the project itself, so there is no id-shaped value to try
// first and the lookup is how the reference is read, not a retry of a failure.
export const resolveProject = async (app: App, value: string): Promise<ProjectIn> => {
  const found = projectsNamed(await allProjects(app, true), value);
  if (found.length === 0) throw new Error(noProject(value));
  if (found.length > 1) throw new Error(severalProjects(value, found));
  return found[0]!;
};

// The complaint the server makes when a value names no project it can place. It
// is the server's own wording, and docs/glossary.md already records it as the
// answer to a value sent where an id was expected.
const NO_PLACE = "Workspace ID could not be determined";

// Whether a failure says the value named no project, rather than the server
// refusing the request for some other reason.
//
// A 404 on a project route says it on its own. A task route has no 404 for it:
// it answers 400 with the complaint above, which is also what a 400 means when
// the server will not accept a body this CLI sent. The status alone cannot tell
// those apart, and guessing costs three requests on every write the server
// rejects for its own reasons, so the message is what decides.
//
// A 403 is a different answer again — the key cannot reach it — and a lookup
// would not change that.
const unknownProject = (e: unknown): e is KaneoApiError =>
  e instanceof KaneoApiError &&
  (e.statusCode === 404 || (e.statusCode === 400 && e.messages.includes(NO_PLACE)));

// The same for a workspace. The project listing answers 403 for one the key has
// no access to, which is also what an unknown one looks like from here, and is
// the reason `--workspace <name>` read as a permission problem.
const unknownWorkspace = (e: unknown): e is KaneoApiError =>
  e instanceof KaneoApiError &&
  (e.statusCode === 403 || e.statusCode === 404 || (e.statusCode === 400 && e.messages.includes(NO_PLACE)));

// The projects a value names, by id, then by slug, then by name.
//
// The three are tried in that order rather than all at once, so a value that is
// an id and also spells somebody's slug is still read as the id it is.
const projectsNamed = (all: ProjectIn[], value: string): ProjectIn[] => {
  const lower = value.toLowerCase();
  const byId = all.filter((p) => p.project.id === value);
  if (byId.length > 0) return byId;
  const bySlug = all.filter((p) => p.project.slug.toLowerCase() === lower);
  if (bySlug.length > 0) return bySlug;
  return all.filter((p) => p.project.name.toLowerCase() === lower);
};

// The same for a workspace.
const workspacesNamed = (all: Workspace[], value: string): Workspace[] => {
  const lower = value.toLowerCase();
  const byId = all.filter((w) => w.id === value);
  if (byId.length > 0) return byId;
  const bySlug = all.filter((w) => w.slug.toLowerCase() === lower);
  if (bySlug.length > 0) return bySlug;
  return all.filter((w) => w.name.toLowerCase() === lower);
};

// Both messages keep the server's own wording in front of them: it is the part
// that says which request failed, and the lookup that follows only says what
// this CLI could not do with it.
const noProject = (value: string): string =>
  `no project has the id, slug or name ${JSON.stringify(value)} (kaneo project find <text> searches by name)`;

const noWorkspace = (value: string): string =>
  `no workspace has the id, slug or name ${JSON.stringify(value)} (kaneo workspace ls lists them)`;

// Two projects can carry the same slug or name, and picking one of them would be
// a rule nobody stated, so they are all named and the id is what chooses.
const severalProjects = (value: string, found: ProjectIn[]): string =>
  `${JSON.stringify(value)} matches several projects: ${found
    .map((p) => `${p.project.slug} (${p.project.id}) in ${p.workspaceName}`)
    .join(", ")}; pass the id`;

const severalWorkspaces = (value: string, found: Workspace[]): string =>
  `${JSON.stringify(value)} matches several workspaces: ${found
    .map((w) => `${w.slug} (${w.id})`)
    .join(", ")}; pass the id`;