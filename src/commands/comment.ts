import type { Command } from "commander";
import { getContext } from "../context";
import { unwrap } from "../api/client";
import { resolveTaskId } from "../api/board";
import { printJson } from "../output";
import type { components } from "../api/schema";

type Comment = components["schemas"]["Comment"];
type Activity = components["schemas"]["Activity"];

function shortDateTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function registerComment(program: Command): void {
  const comment = program.command("comment").description("Work with task comments");

  comment
    .command("list <task>")
    .description("List a task's comments (id, or #number with --project)")
    .option("--project <id>", "project id (needed when referencing by number)")
    .action(async (ref: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const id = await resolveTaskId(client, ref, opts.project);
      const comments = unwrap<Comment[]>(
        await client.GET("/comment/{taskId}", { params: { path: { taskId: id } } }),
      );
      if (flags.json) {
        printJson(comments);
        return;
      }
      if (comments.length === 0) {
        console.log("no comments");
        return;
      }
      for (const c of comments) {
        console.log(`${c.user.name} (${shortDateTime(c.createdAt)}) [${c.id}]`);
        console.log(c.content);
        console.log("");
      }
    });

  comment
    .command("add <task> <content>")
    .description("Add a comment to a task (id, or #number with --project)")
    .option("--project <id>", "project id (needed when referencing by number)")
    .action(async (ref: string, content: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const id = await resolveTaskId(client, ref, opts.project);
      const activity = unwrap<Activity>(
        await client.POST("/comment/{taskId}", { params: { path: { taskId: id } }, body: { content } }),
      );
      if (flags.json) {
        printJson(activity);
        return;
      }
      console.log(`commented on ${ref}`);
    });

  comment
    .command("edit <id> <content>")
    .description("Edit a comment")
    .action(async (id: string, content: string, _opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const activity = unwrap<Activity>(
        await client.PUT("/comment/{id}", { params: { path: { id } }, body: { content } }),
      );
      if (flags.json) {
        printJson(activity);
        return;
      }
      console.log(`updated comment ${id}`);
    });

  comment
    .command("delete <id>")
    .description("Delete a comment")
    .action(async (id: string, _opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const activity = unwrap<Activity>(await client.DELETE("/comment/{id}", { params: { path: { id } } }));
      if (flags.json) {
        printJson(activity);
        return;
      }
      console.log(`deleted comment ${id}`);
    });
}
