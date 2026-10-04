import { apiKey, project, workspace, type App } from "./app";
import { getProject, search, type SearchResult } from "../api/kaneo";
import { minimumArgs, type FlagValues } from "./args";
import { resolveWorkspace, withProject } from "./lookup";

// The server's own bounds on limit (v2.29.2 search/schema.ts), which the
// document does not state.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Searches from the resolved workspace: tasks, projects, comments and activities
// in one ranked list.
export const searchCommand = {
  name: "search",
  use: "search <text...>",
  short: "Search a workspace's tasks, projects, comments and activities",
  long:
    "Search a workspace's tasks, projects, comments and activities.\n\n" +
    "The whole workspace is searched even when the settings resolve a project,\n" +
    "because a repository's project is where a search starts from, not where it\n" +
    "has to stay. --in-project, or a --project given on the command line, narrows\n" +
    "it to that project.\n\n" +
    "The server narrows only tasks, comments and activities to a project: project\n" +
    "matches still come from the whole workspace, and workspace matches from every\n" +
    "workspace the key can reach. Activities include comments.",
  // Several words are one query, as a search box takes them.
  args: minimumArgs(1),
  flags: [
    { name: "type", type: "string" as const, usage: "tasks, projects, workspaces, comments or activities (default every type)", defaultValue: "" },
    { name: "limit", type: "string" as const, usage: `most results to return, at most ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`, defaultValue: "" },
    { name: "in-project", type: "bool" as const, usage: "narrow to the resolved project", defaultValue: "false" },
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
    const inProject = narrow ? await withProject(app, project(app), (id) => getProject(id)) : undefined;
    const limit = String(flags.limit ?? "");
    const found = await search({
      query,
      workspaceId: inProject?.workspaceId ?? (await resolveWorkspace(app, workspace(app))),
      projectId: inProject?.id ?? "",
      type: String(flags.type ?? ""),
      limit,
    });

    const refs = found.results.map(ref);
    const typeWidth = found.results.reduce((at, r) => Math.max(at, r.type.length), 0);
    const refWidth = refs.reduce((at, r) => Math.max(at, r.length), 0);
    for (const [at, r] of found.results.entries()) {
      const status = r.status !== null ? `  (${r.status})` : "";
      app.out.human(`${r.type.padEnd(typeWidth)}  ${refs[at]!.padEnd(refWidth)}  ${r.title}${status}`);
    }
    // totalCount cannot say whether matches were cut (see Search), so a full page
    // is taken to mean there may be more.
    const wanted = limit === "" ? DEFAULT_LIMIT : Number(limit);
    if (found.results.length >= wanted) {
      app.out.human(
        wanted < MAX_LIMIT
          ? `${found.results.length} shown; there may be more (--limit up to ${MAX_LIMIT})`
          : `${found.results.length} shown, the most the server returns; there may be more`,
      );
    }
    app.out.data(found);
  },
};

// Where a match lives, written the way a task reference is: <project>#<number>
// for anything on a task and the project's slug for a project. A workspace match
// has none, since its title already is the workspace's name.
const ref = (r: SearchResult): string => {
  if (r.projectSlug !== null && r.taskNumber !== null) return `${r.projectSlug}#${r.taskNumber}`;
  return r.projectSlug ?? "";
};
