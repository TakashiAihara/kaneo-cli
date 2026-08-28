import type { ApiClient } from "./client";
import { unwrap } from "./client";
import type { components } from "./schema";

export type Board = components["schemas"]["Board"];
export type BoardTask = components["schemas"]["BoardTask"];
export type BoardColumn = components["schemas"]["BoardColumn"];

export async function fetchBoard(
  client: ApiClient,
  projectId: string,
  query: Record<string, string> = {},
): Promise<Board> {
  const result = await client.GET("/task/tasks/{projectId}", {
    params: { path: { projectId }, query },
  });
  return unwrap<components["schemas"]["BoardResponse"]>(result).data;
}

export class TaskNotFoundError extends Error {}

// タスク参照は API の id (不透明文字列) と UI の番号 (#12) の両方を受ける。
// 番号は project 内でしか一意でないので、番号で引くときは --project が要る (glossary: id / number)
export async function resolveTaskId(
  client: ApiClient,
  ref: string,
  projectId: string | undefined,
): Promise<string> {
  const number = ref.replace(/^#/, "");
  if (!/^\d+$/.test(number)) return ref;
  if (!projectId) {
    throw new TaskNotFoundError(
      `"${ref}" looks like a task number; numbers are only unique per project, so pass --project <id>`,
    );
  }
  const board = await fetchBoard(client, projectId);
  const all = [
    ...board.columns.flatMap((c) => c.tasks),
    ...board.archivedTasks,
    ...board.plannedTasks,
  ];
  const hit = all.find((t) => t.number === Number(number));
  if (!hit) {
    throw new TaskNotFoundError(`task #${number} not found in project ${projectId}`);
  }
  return hit.id;
}
