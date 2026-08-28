import type { Command } from "commander";
import { getContext } from "../context";
import { requireWorkspace } from "../config";
import { unwrap } from "../api/client";
import { printJson, printTable, log } from "../output";
import type { components, operations } from "../api/schema";

type Project = components["schemas"]["Project"];
type ProjectListItem = components["schemas"]["ProjectListItem"];
type ListProjectsQuery = operations["listProjects"]["parameters"]["query"];

// "My Project" -> "my-project"。API は slug 必須なので name から機械的に補う
function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function registerProject(program: Command): void {
  const project = program.command("project").description("Work with projects");

  project
    .command("list")
    .description("List a workspace's projects")
    .option("--archived", "include archived projects")
    .action(async (opts, cmd: Command) => {
      const { client, config, flags } = getContext(cmd);
      const workspaceId = requireWorkspace(config);
      const query: ListProjectsQuery = {
        workspaceId,
        ...(opts.archived ? { includeArchived: "true" } : {}),
      };
      const items = unwrap<ProjectListItem[]>(await client.GET("/project", { params: { query } }));
      if (flags.json) {
        printJson(items);
        return;
      }
      printTable(items, [
        { header: "ID", value: (p: ProjectListItem) => p.id },
        { header: "SLUG", value: (p: ProjectListItem) => p.slug },
        { header: "NAME", value: (p: ProjectListItem) => p.name },
        { header: "TASKS", value: (p: ProjectListItem) => String(p.statistics.totalTasks) },
        { header: "ARCHIVED", value: (p: ProjectListItem) => (p.archivedAt ? "yes" : "") },
      ]);
    });

  project
    .command("view <id>")
    .description("Show one project")
    .action(async (id: string, _opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const p = unwrap<Project>(await client.GET("/project/{id}", { params: { path: { id } } }));
      if (flags.json) {
        printJson(p);
        return;
      }
      console.log(`${p.slug} ${p.name}`);
      console.log(`id:          ${p.id}`);
      console.log(`workspace:   ${p.workspaceId}`);
      console.log(`icon:        ${p.icon ?? ""}`);
      console.log(`public:      ${p.isPublic ? "yes" : "no"}`);
      console.log(`archived:    ${p.archivedAt ? "yes" : "no"}`);
      console.log(`created:     ${p.createdAt.slice(0, 10)}`);
      if (p.description) {
        console.log("");
        console.log(p.description);
      }
    });

  project
    .command("create <name>")
    .description("Create a project")
    .option("--slug <slug>", "project slug (default: derived from name)")
    .option("--icon <icon>", "project icon", "📁")
    .action(async (name: string, opts, cmd: Command) => {
      const { client, config, flags } = getContext(cmd);
      const workspaceId = requireWorkspace(config);
      const slug = opts.slug ?? deriveSlug(name);
      const p = unwrap<Project>(
        await client.POST("/project", {
          body: { name, workspaceId, icon: opts.icon, slug },
        }),
      );
      if (flags.json) {
        printJson(p);
        return;
      }
      console.log(`created ${p.slug} ${p.name} (${p.id})`);
    });

  project
    .command("edit <id>")
    .description("Edit a project (name, icon, slug, description, visibility)")
    .option("--name <name>")
    .option("--icon <icon>")
    .option("--slug <slug>")
    .option("--description <text>")
    .option("--public", "make the project publicly readable")
    .option("--no-public", "make the project private")
    .action(async (id: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const hasEdit =
        opts.name !== undefined ||
        opts.icon !== undefined ||
        opts.slug !== undefined ||
        opts.description !== undefined ||
        opts.public !== undefined;
      if (!hasEdit) {
        log("kaneo: nothing to edit — pass at least one field flag (see kaneo project edit --help)");
        process.exit(2);
      }
      // PUT は全量置換なので、まず現在値を取ってから指定分だけ上書きする
      const current = unwrap<Project>(await client.GET("/project/{id}", { params: { path: { id } } }));
      const p = unwrap<Project>(
        await client.PUT("/project/{id}", {
          params: { path: { id } },
          body: {
            name: opts.name ?? current.name,
            icon: opts.icon ?? current.icon ?? "",
            slug: opts.slug ?? current.slug,
            description: opts.description ?? current.description ?? "",
            isPublic: opts.public ?? current.isPublic ?? false,
          },
        }),
      );
      if (flags.json) {
        printJson(p);
        return;
      }
      console.log(`updated ${p.slug} ${p.name}`);
    });

  project
    .command("archive <id>")
    .description("Archive a project")
    .action(async (id: string, _opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const p = unwrap<Project>(await client.PUT("/project/{id}/archive", { params: { path: { id } } }));
      if (flags.json) {
        printJson(p);
        return;
      }
      console.log(`archived ${p.slug} ${p.name}`);
    });

  project
    .command("unarchive <id>")
    .description("Unarchive a project")
    .action(async (id: string, _opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const p = unwrap<Project>(await client.PUT("/project/{id}/unarchive", { params: { path: { id } } }));
      if (flags.json) {
        printJson(p);
        return;
      }
      console.log(`unarchived ${p.slug} ${p.name}`);
    });

  project
    .command("delete <id>")
    .description("Delete a project permanently")
    .action(async (id: string, _opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const p = unwrap<Project>(await client.DELETE("/project/{id}", { params: { path: { id } } }));
      if (flags.json) {
        printJson(p);
        return;
      }
      console.log(`deleted ${p.slug} ${p.name}`);
    });
}
