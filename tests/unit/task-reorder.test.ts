import { describe, expect, test } from "bun:test";
import { planTaskMove } from "../../src/cli/task-reorder";
import type { Board, Task } from "../../src/api/kaneo";

// A board the way getBoard reports it: column id is the status slug a task in
// it carries, and position is the sort key within the column.
const task = (id: string, position: number, status = "to-do"): Task => ({
  id,
  number: 0,
  title: id,
  description: "",
  status,
  priority: "",
  position,
  projectId: "p1",
  assigneeId: null,
  assigneeName: null,
  startDate: null,
  dueDate: null,
  createdAt: "",
  labels: null,
});

const board = (...columns: { id: string; tasks: Task[] }[]): Board => ({
  projectId: "p1",
  projectName: "P",
  projectSlug: "P",
  columns: columns.map((c) => ({ id: c.id, name: c.id, tasks: c.tasks })),
});

describe("planTaskMove", () => {
  test("moving within a column takes the midpoint and sends only what changed", () => {
    const b = board({ id: "to-do", tasks: [task("a", 0), task("x", 1024), task("y", 2048)] });
    // x before y is where it already sits: the midpoint lands on its old
    // position, so nothing is sent and the CLI reports the no-op.
    expect(planTaskMove(b, "x", "y", "before")).toEqual({ tasks: [], expectedTasks: [{ id: "a", position: 0, status: "to-do" }, { id: "x", position: 1024, status: "to-do" }, { id: "y", position: 2048, status: "to-do" }] });
    // x after y is a real move: x lands at the end, one past y's position.
    const plan = planTaskMove(b, "x", "y", "after")!;
    expect(plan.tasks).toEqual([{ id: "x", position: 2049 }]);
    expect(plan.expectedTasks).toHaveLength(3);
  });

  test("moving before the first task gives it the top slot", () => {
    const b = board({ id: "to-do", tasks: [task("a", 100), task("x", 200)] });
    const plan = planTaskMove(b, "x", "a", "before")!;
    // The midpoint between the column's implicit floor and a's position.
    expect(plan.tasks).toEqual([{ id: "x", position: 49 }]);
    expect(plan.expectedTasks.map((t) => t.id)).toEqual(["a", "x"]);
  });

  test("crossing columns sets the destination slug as status and snapshots both columns", () => {
    const b = board(
      { id: "to-do", tasks: [task("a", 0), task("x", 1024)] },
      { id: "in-progress", tasks: [task("b", 0, "in-progress"), task("c", 1024, "in-progress")] },
    );
    const plan = planTaskMove(b, "x", "c", "before")!;
    // Only x changed: it leaves to-do and slots between b and c.
    expect(plan.tasks).toEqual([{ id: "x", position: 512, status: "in-progress" }]);
    expect(plan.expectedTasks).toEqual([
      { id: "a", position: 0, status: "to-do" },
      { id: "x", position: 1024, status: "to-do" },
      { id: "b", position: 0, status: "in-progress" },
      { id: "c", position: 1024, status: "in-progress" },
    ]);
  });

  test("a packed column re-spaces at 1024 intervals rather than fail", () => {
    // Consecutive positions leave no midpoint and more than four neighbours to
    // shift, so the whole column is laid out again.
    const b = board({ id: "to-do", tasks: [task("a", 0), task("x", 1), task("y", 2), task("z", 3), task("w", 4), task("v", 5)] });
    const plan = planTaskMove(b, "v", "a", "before")!;
    expect(plan.tasks.find((t) => t.id === "v")).toEqual({ id: "v", position: 1024 });
    expect(plan.tasks.find((t) => t.id === "a")).toEqual({ id: "a", position: 2048 });
  });

  test("the planned and archived pseudo-columns are destinations like any other", () => {
    const b = board({ id: "to-do", tasks: [task("x", 0)] }, { id: "planned", tasks: [task("p", 0, "planned")] });
    const plan = planTaskMove(b, "x", "p", "after")!;
    expect(plan.tasks).toEqual([{ id: "x", position: 1, status: "planned" }]);
    expect(plan.expectedTasks).toEqual([
      { id: "x", position: 0, status: "to-do" },
      { id: "p", position: 0, status: "planned" },
    ]);
  });

  test("a task the board does not hold, or itself, has no plan", () => {
    const b = board({ id: "to-do", tasks: [task("a", 0), task("x", 1)] });
    expect(planTaskMove(b, "x", "x", "after")).toBeUndefined();
    expect(planTaskMove(b, "missing", "a", "after")).toBeUndefined();
    expect(planTaskMove(b, "x", "missing", "after")).toBeUndefined();
  });
});
