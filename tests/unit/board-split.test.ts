import { expect, test } from "bun:test";
import { startFake, type Seed } from "../parity/fake";

// The board answers a task that sits in no column beside the columns, one list
// each. The CLI does not read those lists yet (#44), so nothing a scenario
// records would notice the split moving; this reads the route directly.
const SEED: Seed = {
  workspaces: [{ id: "ws", name: "Main", slug: "main" }],
  projects: [{ id: "proj", workspaceId: "ws", name: "Alpha", slug: "ALP" }],
  tasks: [
    { id: "task-open", projectId: "proj", title: "Open" },
    { id: "task-archived", projectId: "proj", title: "Archived", status: "archived" },
    { id: "task-planned", projectId: "proj", title: "Planned", status: "planned" },
  ],
};

test("the board answers archived and planned tasks beside the columns", async () => {
  const fake = startFake(SEED);
  try {
    const res = await fetch(`${fake.url}/api/task/tasks/proj`, {
      headers: { authorization: "Bearer test-key" },
    });
    expect(res.status).toBe(200);
    const board = (await res.json()) as {
      data: {
        columns: { slug: string; tasks: { id: string }[] }[];
        archivedTasks: { id: string }[];
        plannedTasks: { id: string }[];
      };
    };
    const inColumns = board.data.columns.flatMap((c) => c.tasks.map((t) => t.id));
    expect(inColumns).toEqual(["task-open"]);
    expect(board.data.archivedTasks.map((t) => t.id)).toEqual(["task-archived"]);
    expect(board.data.plannedTasks.map((t) => t.id)).toEqual(["task-planned"]);
  } finally {
    fake.stop();
  }
});
