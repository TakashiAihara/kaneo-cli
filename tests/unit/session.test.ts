import { expect, test } from "bun:test";
import { releaseRef } from "../../src/cli/session";
import type { Attachment } from "../../src/session/store";

const held: Attachment = { taskId: "task-a1", number: 1, title: "Write the parser", projectId: "proj-alpha" };

test("a bare number resolves on the releasing session's project", () => {
  expect(releaseRef(held, "1")).toBe("proj-alpha#1");
  expect(releaseRef(held, "12")).toBe("proj-alpha#12");
});

test("a bare number with no record stays in the current project", () => {
  expect(releaseRef(undefined, "1")).toBe("1");
});

test("a bare number with a record but no project stays in the current project", () => {
  expect(releaseRef({ taskId: "task-a1", number: 1, title: "Write the parser" }, "1")).toBe("1");
  expect(releaseRef({ ...held, projectId: "" }, "1")).toBe("1");
});

test("a value naming a board, a ticket id or a task is left as typed", () => {
  for (const ref of ["ALP#1", "alp#1", "ALP-1", "task-a1", "#1", "1.5", "x1"]) {
    expect(releaseRef(held, ref)).toBe(ref);
  }
});
