import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { getContext } from "../context";
import { requireWorkspace } from "../config";
import { unwrap } from "../api/client";
import { printJson, printTable } from "../output";
import type { components, operations } from "../api/schema";

type SearchResponse = components["schemas"]["SearchResponse"];
type SearchResult = components["schemas"]["SearchResult"];
type SearchQuery = operations["globalSearch"]["parameters"]["query"];

// openapi.json operations["globalSearch"].parameters.query.type の実際の enum。
// タスク仕様書では単数形 (task|project|...) だったが、API は複数形 + "all" を受ける
const SEARCH_TYPES = ["all", "tasks", "projects", "workspaces", "comments", "activities"] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

function parseSearchType(value: string): SearchType {
  if ((SEARCH_TYPES as readonly string[]).includes(value)) return value as SearchType;
  throw new InvalidArgumentError(`must be one of: ${SEARCH_TYPES.join(", ")}`);
}

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("Search tasks, projects, workspaces, comments, and activities")
    .option("--type <type>", `filter: ${SEARCH_TYPES.join(" | ")}`, parseSearchType)
    .option("--project <id>", "restrict to one project")
    .option("--limit <n>", "max results")
    .action(async (q: string, opts, cmd: Command) => {
      const { client, config, flags } = getContext(cmd);
      const workspaceId = requireWorkspace(config);
      const searchQuery: SearchQuery = {
        q,
        workspaceId,
        ...(opts.type ? { type: opts.type as SearchType } : {}),
        ...(opts.project ? { projectId: opts.project } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
      };
      const result = unwrap<SearchResponse>(
        await client.GET("/search", { params: { query: searchQuery } }),
      );
      if (flags.json) {
        printJson(result);
        return;
      }
      if (result.results.length === 0) {
        console.log("no results");
        return;
      }
      printTable(result.results, [
        { header: "TYPE", value: (r: SearchResult) => r.type },
        { header: "TITLE", value: (r: SearchResult) => r.title },
        { header: "PROJECT", value: (r: SearchResult) => r.projectName ?? "" },
        { header: "ID", value: (r: SearchResult) => r.id },
      ]);
      if (result.totalCount > result.results.length) {
        console.log(`showing ${result.results.length} of ${result.totalCount}`);
      }
    });
}
