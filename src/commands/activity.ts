import type { Command } from "commander";
import { getContext } from "../context";
import { unwrap } from "../api/client";
import { resolveTaskId } from "../api/board";
import { printJson } from "../output";
import type { components } from "../api/schema";

type Activity = components["schemas"]["Activity"];

function shortDateTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function registerActivity(program: Command): void {
  program
    .command("activity <task>")
    .description("Show a task's activity feed (id, or #number with --project)")
    .option("--project <id>", "project id (needed when referencing by number)")
    .action(async (ref: string, opts, cmd: Command) => {
      const { client, flags } = getContext(cmd);
      const id = await resolveTaskId(client, ref, opts.project);
      const activities = unwrap<Activity[]>(
        await client.GET("/activity/{taskId}", { params: { path: { taskId: id } } }),
      );
      if (flags.json) {
        printJson(activities);
        return;
      }
      if (activities.length === 0) {
        console.log("no activity");
        return;
      }
      for (const a of activities) {
        const body = a.content ?? JSON.stringify(a.eventData ?? null);
        console.log(`${shortDateTime(a.createdAt)} ${a.type} ${body}`);
      }
    });
}
