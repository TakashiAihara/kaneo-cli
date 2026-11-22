import { apiKey, project, workspace, type App } from "./app";
import {
  getProject,
  listProjectsForSearch,
  listWorkspaces,
  search,
  type DatedProject,
  type SearchQuery,
  type SearchResult,
} from "../api/kaneo";
import { minimumArgs, type FlagValues } from "./args";
import { resolveWorkspaceIn, slugOr, withProject } from "./lookup";

// The server's own bounds on limit (v2.29.2 search/schema.ts), which the
// document does not state.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Searches from the resolved workspace, or from every one with -A: tasks,
// projects, comments and activities in one ranked list.
export const searchCommand = {
  name: "search",
  use: "search <text...>",
  short: "Search a workspace's tasks, projects, comments and activities, or every workspace's",
  long:
    "Search a workspace's tasks, projects, comments and activities.\n\n" +
    "The whole workspace is searched even when the settings resolve a project,\n" +
    "because a repository's project is where a search starts from, not where it\n" +
    "has to stay. --in-project, or a --project given on the command line, narrows\n" +
    "it to that project.\n\n" +
    "The server narrows only tasks, comments and activities to a project: project\n" +
    "matches still come from the whole workspace, and workspace matches from every\n" +
    "workspace the key can reach. Activities include comments.\n\n" +
    "--all-workspaces searches every workspace the key can reach and ranks the\n" +
    "matches as one list, cut to --limit as a single search would be.",
  // Several words are one query, as a search box takes them.
  args: minimumArgs(1),
  flags: [
    {
      name: "type",
      type: "string" as const,
      usage: "tasks, projects, workspaces, comments or activities (default every type)",
      defaultValue: "",
    },
    {
      name: "limit",
      type: "string" as const,
      usage: `most results to return, at most ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`,
      defaultValue: "",
    },
    { name: "in-project", type: "bool" as const, usage: "narrow to the resolved project", defaultValue: "false" },
    {
      name: "all-workspaces",
      shorthand: "A",
      type: "bool" as const,
      usage: "search every workspace the key can reach; cannot be combined with -w",
      defaultValue: "false",
    },
  ],
  run: async ({ args, flags, app }: { args: string[]; flags: FlagValues; app: App }) => {
    apiKey(app);
    const query = args.join(" ").trim();
    if (query === "") throw new Error("a search needs some text");
    // The server answers a project it does not know by that id — a slug, a name —
    // with no results rather than an error, so the project is read first: that
    // turns a slug into the id and fails loudly for a project that does not
    // exist. Its workspace is the one searched, since a project is in exactly one.
    const narrow = flags["in-project"] === true || app.flags.projectId !== "";
    const acrossAll = flags["all-workspaces"] === true;
    if (narrow && acrossAll)
      throw new Error("--all-workspaces searches every workspace, so it cannot be narrowed to a project");
    if (acrossAll && app.flags.workspaceId !== "") {
      throw new Error("--all-workspaces searches every workspace, so it cannot be narrowed with --workspace");
    }
    const limit = String(flags.limit ?? "");
    const type = String(flags.type ?? "");
    const wanted = limit === "" ? DEFAULT_LIMIT : Number(limit);
    let found;
    let more: boolean;
    if (acrossAll) {
      ({ found, more } = await searchEverywhere({ query, workspaceId: "", projectId: "", type, limit }, wanted));
    } else {
      const inProject = narrow ? await withProject(project(app), (id) => getProject(id)) : undefined;
      // The workspace's name comes free with the resolution when the search is
      // not narrowed; narrowed to a project it is only needed if a slug match
      // is added below, and is looked up then.
      let workspaceId: string;
      let workspaceName: string | undefined;
      if (inProject === undefined) {
        const ws = await resolveWorkspaceIn(workspace(app));
        workspaceId = ws.id;
        workspaceName = ws.name;
      } else {
        workspaceId = inProject.workspaceId;
      }
      const [page, listed] = await Promise.all([
        search({
          query,
          workspaceId,
          projectId: inProject?.id ?? "",
          type,
          limit,
        }),
        wantsProjects(type) ? listProjectsForSearch(workspaceId) : Promise.resolve<DatedProject[]>([]),
      ]);
      found = page.found;
      // totalCount cannot say whether matches were cut (see Search), so a page
      // the server filled, repeats counted, is taken to mean there may be more.
      // The repeats still take places in the server's page, so it can show fewer
      // than --limit even then.
      more = page.rows >= wanted;
      // The server's project query matches name and description but not slug,
      // so the slug matches it cannot see are added from the listing. They rank
      // and cut like the server's own, so the merged list is resorted.
      const candidates = slugCandidates(listed, found.results, query);
      if (candidates.length > 0) {
        const name = workspaceName ?? (await listWorkspaces()).find((w) => w.id === workspaceId)?.name ?? workspaceId;
        const extra = candidates.map((p) => projectResult(p, name));
        const merged = [...found.results, ...extra].sort(byRank);
        found = { ...found, totalCount: found.totalCount + extra.length, results: merged.slice(0, wanted) };
        more ||= merged.length > wanted;
      }
    }

    const refs = found.results.map(ref);
    const typeWidth = found.results.reduce((at, r) => Math.max(at, r.type.length), 0);
    const refWidth = refs.reduce((at, r) => Math.max(at, r.length), 0);
    for (const [at, r] of found.results.entries()) {
      const status = r.status !== null ? `  (${r.status})` : "";
      // Slugs are unique only inside a workspace, so a reference from more than
      // one has to say which, spelled out the way `project ls -A` spells it so
      // it cannot be read as the status marker beside it. A workspace match is
      // named by its own title.
      const where = acrossAll && r.type !== "workspace" ? `  (workspace: ${r.workspaceName})` : "";
      app.out.human(`${r.type.padEnd(typeWidth)}  ${refs[at]!.padEnd(refWidth)}  ${r.title}${status}${where}`);
    }
    if (more) {
      app.out.human(
        wanted < MAX_LIMIT
          ? `${found.results.length} shown; there may be more (--limit up to ${MAX_LIMIT})`
          : `${found.results.length} shown, the most the server returns; there may be more`,
      );
    }
    app.out.data(found);
  },
};

// The types whose results can include a project. The server's default is
// "all", so an empty --type asks for them too; the project listing is only
// read for these, since no other type can return a project match.
const wantsProjects = (type: string): boolean => type === "" || type === "all" || type === "projects";

// The server's own ordering: relevance, then newest first on a tie.
const byRank = (a: SearchResult, b: SearchResult): number =>
  b.relevanceScore - a.relevanceScore || Date.parse(b.createdAt) - Date.parse(a.createdAt);

// The listed projects whose slug contains the query and that the server's
// results do not already name. The server's project query matches the name
// and the description but never the slug (global-search.ts in Kaneo), so a
// project findable by the key every task reference starts with would
// otherwise never surface.
const slugCandidates = (listed: DatedProject[], results: SearchResult[], query: string): DatedProject[] => {
  const have = new Set(results.filter((r) => r.type === "project").map((r) => r.id));
  const q = query.toLowerCase();
  return listed.filter((p) => !have.has(p.id) && p.slug.toLowerCase().includes(q));
};

// A project as a search result, the way the server shapes its own project
// matches: description and slug are absent when empty, projectName is left
// unset, and the slug is the project's key, so a slug match ranks like a name
// match.
const projectResult = (p: DatedProject, workspaceName: string): SearchResult => ({
  id: p.id,
  type: "project",
  title: p.name,
  description: p.description === "" ? null : p.description,
  content: null,
  projectId: p.id,
  projectName: null,
  projectSlug: p.slug === "" ? null : p.slug,
  workspaceId: p.workspaceId,
  workspaceName,
  userId: null,
  userName: null,
  createdAt: p.createdAt,
  relevanceScore: 3,
  taskNumber: null,
  number: null,
  priority: null,
  status: null,
});

// One search per workspace, merged the way v2.29.2 merges its per-type queries:
// by relevance, newest first on a tie, then cut to the limit. The server takes
// workspace matches from every workspace the key can reach whichever one is
// asked, and repeats each once per member (v2.29.2 joins the members without
// narrowing them), so the same workspace comes back many times and is kept once.
// Those repeats take places in each workspace's page, so every workspace is asked
// for the most the server returns rather than for --limit, which the server then
// no longer checks; it is checked here instead. There may be more when the merge
// had to be cut, or when a workspace's page came back full.
// ponytail: a workspace page of 50 filled by repeats, or by more than 50 matches, still drops matches that would rank in; the hint then says there may be more. Asking for workspaces apart from the other types would end the repeats' share.
const searchEverywhere = async (wanted: SearchQuery, limit: number) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  let pageFull = false;
  for (const w of await listWorkspaces()) {
    const [page, listed] = await Promise.all([
      search({ ...wanted, workspaceId: w.id, limit: String(MAX_LIMIT) }),
      wantsProjects(wanted.type) ? listProjectsForSearch(w.id) : Promise.resolve<DatedProject[]>([]),
    ]);
    pageFull ||= page.rows >= MAX_LIMIT;
    for (const r of page.found.results) {
      const key = `${r.type} ${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
    for (const p of slugCandidates(listed, merged, wanted.query)) {
      const r = projectResult(p, w.name);
      seen.add(`${r.type} ${r.id}`);
      merged.push(r);
    }
  }
  merged.sort(byRank);
  // totalCount counts the distinct matches before the cut, out of pages the
  // server has already cut to 50 each.
  const found = { query: wanted.query, totalCount: merged.length, results: merged.slice(0, limit) };
  return { found, more: pageFull || merged.length > limit };
};

// Where a match lives, written the way a task reference is: <project>#<number>
// for anything on a task and the project's slug for a project. A workspace match
// has none, since its title already is the workspace's name.
const ref = (r: SearchResult): string => {
  // A project whose slug is empty is named by its id.
  const slug = r.projectSlug === null ? null : slugOr(r.projectSlug, r.projectId ?? "");
  if (slug !== null && r.taskNumber !== null) return `${slug}#${r.taskNumber}`;
  return slug ?? "";
};
