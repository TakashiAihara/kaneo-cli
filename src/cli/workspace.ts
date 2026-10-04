import { apiKey, workspace, type App } from "./app";
import { listMembers, listWorkspaces, renameWorkspace } from "../api/kaneo";
import { resolveWorkspace } from "./lookup";
import type { Json } from "../output/json";

const noArgs = (path: string) => (args: string[]) => {
  const first = args[0];
  if (first !== undefined) throw new Error(`unknown command ${JSON.stringify(first)} for ${JSON.stringify(path)}`);
};

export const workspaceCommand = {
  name: "workspace",
  aliases: ["ws"],
  short: "Work with workspaces",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List workspaces the key can reach",
      args: noArgs("kaneo workspace list"),
      run: async ({ app }: { app: App }) => {
        apiKey(app);
        const workspaces = await listWorkspaces();
        for (const workspace of workspaces) app.out.human(`${workspace.id}  ${workspace.name}`);
        app.out.data(workspaces as Json);
      },
    },
    {
      name: "members",
      short: "List the resolved workspace's members and their roles",
      args: noArgs("kaneo workspace members"),
      run: async ({ app }: { app: App }) => {
        apiKey(app);
        const members = await listMembers(await resolveWorkspace(app, workspace(app)));
        const idWidth = members.reduce((at, m) => Math.max(at, m.id.length), 0);
        const roleWidth = members.reduce((at, m) => Math.max(at, m.role.length), 0);
        for (const m of members) {
          app.out.human(`${m.id.padEnd(idWidth)}  ${m.role.padEnd(roleWidth)}  ${m.name} <${m.email}>`);
        }
        app.out.data(members as Json);
      },
    },
    {
      name: "rename",
      use: "rename <workspace-id> <name>",
      short: "Rename a workspace; the slug is kept",
      args: (args: string[]) => {
        if (args.length < 2) throw new Error(`requires at least 2 arg(s), only received ${args.length}`);
      },
      // The id is a required argument rather than resolved like -w: resolution
      // falls back to .kaneo.json and the owners map, so a rename typed inside a
      // checkout would quietly hit whichever workspace that repo maps to.
      run: async ({ args, app }: { args: string[]; app: App }) => {
        apiKey(app);
        const workspaces = await listWorkspaces();
        const [id, ...rest] = args as [string, ...string[]];
        const before = workspaces.find((workspace) => workspace.id === id);
        if (before === undefined) {
          throw new Error(`workspace ${JSON.stringify(id)} is not one this key can reach (see kaneo workspace ls)`);
        }

        const after = await renameWorkspace(before.id, rest.join(" "));
        app.out.human(`renamed ${after.id}  ${before.name} -> ${after.name}`);
        // A map's keys come out sorted, which is the order the report has.
        app.out.data({ from: before.name, id: after.id, slug: after.slug, to: after.name });
      },
    },
  ],
};
