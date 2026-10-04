import { apiKey, project, workspace, type App } from "./app";
import { getProject, listWorkspaces, search, type SearchQuery, type SearchResult } from "../api/kaneo";
import { minimumArgs, type FlagValues } from "./args";
import { resolveWorkspace, withProject } from "./lookup";

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
    { name: "type", type: "string" as const, usage: "tasks, projects, workspaces, comments or activities (default every type)", defaultValue: "" },
    { name: "limit", type: "string" as const, usage: `most results to return, at most ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`, defaultValue: "" },
    { name: "in-project", type: "bool" as const, usage: "narrow to the resolved project", defaultValue: "false" },
    { name: "all-workspaces", shorthand: "A", type: "bool" as const, usage: "search every workspace the key can reach", defaultValue: "false" },
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
    if (narrow && acrossAll) throw new Error("--all-workspaces searches every workspace, so it cannot be narrowed to a project");
    const limit = String(flags.limit ?? "");
    const type = String(flags.type ?? "");
    const wanted = limit === "" ? DEFAULT_LIMIT : Number(limit);
    let found;
    let more: boolean;
    if (acrossAll) {
      ({ found, more } = await searchEverywhere({ query, workspaceId: "", projectId: "", type, limit }, wanted));
    } else {
      const inProject = narrow ? await withProject(project(app), (id) => getProject(id)) : undefined;
      const page = await search({
        query,
        workspaceId: inProject?.workspaceId ?? (await resolveWorkspace(workspace(app))),
        projectId: inProject?.id ?? "",
        type,
        limit,
      });
      found = page.found;
      // totalCount cannot say whether matches were cut (see Search), so a page
      // the server filled, repeats counted, is taken to mean there may be more.
      // The repeats still take places in the server's page, so it can show fewer
      // than --limit even then.
      more = page.rows >= wanted;
    }

    const refs = found.results.map(ref);
    const typeWidth = found.results.reduce((at, r) => Math.max(at, r.type.length), 0);
    const refWidth = refs.reduce((at, r) => Math.max(at, r.length), 0);
    for (const [at, r] of found.results.entries()) {
      const status = r.status !== null ? `  (${r.status})` : "";
      // Slugs are unique only inside a workspace, so a reference from more than
      // one has to say which, as `project ls -A` does. A workspace match is named
      // by its own title.
      const where = acrossAll && r.type !== "workspace" ? `  (${r.workspaceName})` : "";
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
    const page = await search({ ...wanted, workspaceId: w.id, limit: String(MAX_LIMIT) });
    pageFull ||= page.rows >= MAX_LIMIT;
    for (const r of page.found.results) {
      const key = `${r.type} ${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
  }
  merged.sort((a, b) => b.relevanceScore - a.relevanceScore || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  // totalCount counts the distinct matches before the cut, out of pages the
  // server has already cut to 50 each.
  const found = { query: wanted.query, totalCount: merged.length, results: merged.slice(0, limit) };
  return { found, more: pageFull || merged.length > limit };
};

// Where a match lives, written the way a task reference is: <project>#<number>
// for anything on a task and the project's slug for a project. A workspace match
// has none, since its title already is the workspace's name.
const ref = (r: SearchResult): string => {
  if (r.projectSlug !== null && r.taskNumber !== null) return `${r.projectSlug}#${r.taskNumber}`;
  return r.projectSlug ?? "";
};
