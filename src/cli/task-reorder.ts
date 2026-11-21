import type { Board } from "../api/kaneo";
import type { TaskPlacement, TaskSnapshot } from "../api/kaneo";
import { storedTaskPosition } from "../api/kaneo";

// How `kaneo task reorder` decides what to send to POST /task/reorder.
//
// The computation is a port of the web board's own move (usekaneo/kaneo
// apps/web/src/components/kanban-board/move-task.ts and place-moved-task.ts,
// v2.32.0): the moved task is taken out of its column, put before or after the
// task it was named against, and given the column's slug as its status when
// the move crosses columns. Only the tasks whose position or status changed
// are sent, and expectedTasks is the previous complete contents of the
// columns touched, which is what lets the server answer 409 on a stale board.

// One task's sort key within its column. position keeps the stored null the
// board read reports as 0: expectedTasks has to name it back for the server's
// comparison, and the placement arithmetic below reads a missing one as -1.
type Slot = { id: string; position: number | null; status: string };

type Positioned = { position?: number | null };

const SPACING = 1024;
const MAX_SHIFT = 4;

function costAfter(tasks: Positioned[], index: number) {
  let floor = (tasks[index - 1]?.position ?? -1) + 1;
  let cost = 0;
  for (let i = index + 1; i < tasks.length; i++) {
    if ((tasks[i]!.position ?? -1) > floor) break;
    floor += 1;
    cost += 1;
  }
  return cost;
}

function costBefore(tasks: Positioned[], index: number) {
  let ceiling = (tasks[index + 1]!.position as number) - 1;
  if (ceiling < 0) return Number.POSITIVE_INFINITY;
  let cost = 0;
  for (let i = index - 1; i >= 0; i--) {
    const position = tasks[i]!.position;
    if (position != null && position < ceiling) break;
    ceiling -= 1;
    if (ceiling < 0) return Number.POSITIVE_INFINITY;
    cost += 1;
  }
  return cost;
}

function shiftBefore(tasks: Positioned[], index: number) {
  let ceiling = (tasks[index + 1]!.position as number) - 1;
  tasks[index]!.position = ceiling;
  for (let i = index - 1; i >= 0; i--) {
    const position = tasks[i]!.position;
    if (position != null && position < ceiling) break;
    ceiling -= 1;
    tasks[i]!.position = ceiling;
  }
}

function shiftAfter(tasks: Positioned[], index: number) {
  let floor = (tasks[index - 1]?.position ?? -1) + 1;
  tasks[index]!.position = floor;
  for (let i = index + 1; i < tasks.length; i++) {
    if ((tasks[i]!.position ?? -1) > floor) break;
    floor += 1;
    tasks[i]!.position = floor;
  }
}

// Gives the task just inserted at index a position between its new neighbours:
// the midpoint when there is room, a bounded shift of the neighbours when there
// is not, and a full re-spacing at 1024 intervals when neither is cheap. The
// board only needs an order, not a pretty one, so any integer the server
// accepts does.
function placeMovedTask(tasks: Positioned[], index: number) {
  const low = tasks[index - 1]?.position ?? -1;
  const next = tasks[index + 1]?.position;
  if (next == null) {
    tasks[index]!.position = low + 1;
    return;
  }
  if (next - low > 1) {
    tasks[index]!.position = Math.floor((low + next) / 2);
    return;
  }
  const before = costBefore(tasks, index);
  const after = costAfter(tasks, index);
  if (Math.min(before, after) <= MAX_SHIFT) {
    if (before < after) shiftBefore(tasks, index);
    else shiftAfter(tasks, index);
    return;
  }
  tasks.forEach((task, position) => {
    task.position = (position + 1) * SPACING;
  });
}

export type TaskMovePlan = { tasks: TaskPlacement[]; expectedTasks: TaskSnapshot[] };

// The reorder a `task reorder <task> --before|--after <task>` asks for, or
// undefined when either task is not on the board that was read.
//
// The board's column id is the status a task in it carries — real columns
// report their slug there, and the planned and archived pseudo-columns their
// own names — so moving across columns is the same operation as moving within
// one: the moved task's status becomes the destination column's id.
export const planTaskMove = (board: Board, moveId: string, anchorId: string, side: "before" | "after"): TaskMovePlan | undefined => {
  // A task moved against itself has no place to go; the caller refuses it
  // before this, but the index arithmetic below would read a missing anchor.
  if (moveId === anchorId) return undefined;
  const columns = board.columns.map((column) => ({
    id: column.id,
    // The snapshot the server compares against, taken before anything moves.
    before: column.tasks.map((t): Slot => ({ id: t.id, position: storedTaskPosition(t), status: t.status })),
    tasks: column.tasks.map((t): Slot => ({ id: t.id, position: storedTaskPosition(t), status: t.status })),
  }));
  const source = columns.find((c) => c.tasks.some((t) => t.id === moveId));
  const dest = columns.find((c) => c.tasks.some((t) => t.id === anchorId));
  if (source === undefined || dest === undefined) return undefined;

  const from = source.tasks;
  const moved = from.splice(
    from.findIndex((t) => t.id === moveId),
    1,
  )[0]!;
  moved.status = dest.id;
  const index = dest.tasks.findIndex((t) => t.id === anchorId) + (side === "after" ? 1 : 0);
  dest.tasks.splice(index, 0, moved);
  placeMovedTask(dest.tasks, index);

  // The columns the move touched, once each: the source and the destination
  // are the same object when the move stays inside one column.
  const affected = [...new Set([source, dest])];
  // What each task was before the move, across the whole board: the moved
  // task is missing from its destination column's own snapshot, which is
  // exactly the change being sent.
  const was = new Map(columns.flatMap((column) => column.before.map((t) => [t.id, t] as const)));
  const tasks: TaskPlacement[] = [];
  for (const column of affected) {
    for (const t of column.tasks) {
      const old = was.get(t.id)!;
      if (old.position !== t.position || old.status !== t.status) {
        tasks.push({ id: t.id, position: t.position ?? 0, ...(old.status !== t.status ? { status: t.status } : {}) });
      }
    }
  }
  const expectedTasks = affected.flatMap((column) =>
    column.before.map((t): TaskSnapshot => ({ id: t.id, position: t.position, status: t.status })),
  );
  return { tasks, expectedTasks };
};
