import type { Command } from "commander";
import { getContext } from "../context";
import { requireWorkspace } from "../config";
import { unwrap } from "../api/client";
import { printJson, printTable } from "../output";
import type { components } from "../api/schema";

type WorkspaceMember = components["schemas"]["WorkspaceMember"];

// /auth/organization/list は better-auth の生 endpoint で型を持たない (schema 上は unknown[])。
// glossary どおり CLI 側は "organization" を一切出さず "workspace" とだけ呼ぶ
type OrganizationLike = { id?: string; name?: string; slug?: string };

export function registerWorkspace(program: Command): void {
  const workspace = program.command("workspace").description("Work with workspaces");

  workspace
    .command("list")
    .description("List workspaces you belong to")
    .action(async (_opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const items = unwrap<unknown[]>(await client.GET("/auth/organization/list"));
      if (flags.json) {
        printJson(items);
        return;
      }
      const rows = items as OrganizationLike[];
      printTable(rows, [
        { header: "ID", value: (w: OrganizationLike) => w.id ?? "" },
        { header: "SLUG", value: (w: OrganizationLike) => w.slug ?? "" },
        { header: "NAME", value: (w: OrganizationLike) => w.name ?? "" },
      ]);
    });

  workspace
    .command("members [workspaceId]")
    .description("List a workspace's members")
    .action(async (workspaceId: string | undefined, _opts, cmd: Command) => {
      const { client, config, flags } = getContext(cmd);
      const id = workspaceId ?? requireWorkspace(config);
      const members = unwrap<WorkspaceMember[]>(
        await client.GET("/workspace/{workspaceId}/members", { params: { path: { workspaceId: id } } }),
      );
      if (flags.json) {
        printJson(members);
        return;
      }
      printTable(members, [
        { header: "ID", value: (m: WorkspaceMember) => m.id },
        { header: "NAME", value: (m: WorkspaceMember) => m.name },
        { header: "EMAIL", value: (m: WorkspaceMember) => m.email },
        { header: "ROLE", value: (m: WorkspaceMember) => m.role },
      ]);
    });
}
