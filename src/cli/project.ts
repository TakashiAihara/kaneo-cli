import { apiKey, workspace, type App } from "./app";
import { archived, listProjectsIn, type Project } from "../api/kaneo";

// The projects in a workspace.
//
// Only the listing is here: the rest of `project` arrives with the step that
// ports it, and a command half-built would be worse than one that is not.
export const projectCommand = {
  name: "project",
  aliases: ["proj"],
  short: "Work with projects",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List the projects in a workspace",
      args: (args: string[]) => {
        const first = args[0];
        if (first !== undefined) {
          throw new Error(`unknown command ${JSON.stringify(first)} for "kaneo project list"`);
        }
      },
      flags: [
        {
          name: "archived",
          type: "bool" as const,
          usage: "include archived projects, so one can be found again to unarchive",
          defaultValue: "false",
        },
      ],
      run: async ({ flags, app }: { flags: Record<string, string | boolean | number>; app: App }) => {
        apiKey(app);
        const projects: Project[] = await listProjectsIn(
          workspace(app),
          flags.archived === true,
        );
        for (const project of projects) {
          app.out.human(
            archived(project)
              ? `${project.id}  ${project.name}  (archived)`
              : `${project.id}  ${project.name}`,
          );
        }
        app.out.data(projects);
      },
    },
  ],
};
