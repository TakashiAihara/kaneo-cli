import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { configureClient, KaneoApiError } from "../../src/api/http";
import * as api from "../../src/api/kaneo";

// Ported from the Go build's internal/api/operations_test.go. Each test serves
// the requests from a local Bun.serve and reads what the call put on the wire.
// TestRegistryMatchesTheGeneratedClient is not ported: tests/registry.test.ts
// holds the registry to the pinned document and to the generated client.

type Handler = (req: Request) => Response | Promise<Response>;
const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

const newServer = (handler: Handler) => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(s);
  configureClient({ baseUrl: `http://127.0.0.1:${s.port}`, apiKey: "test-key" });
};

type Seen = { method: string; path: string; query: string; body: string };

// Captures the last request a call makes and answers with reply.
const recorder = (reply: string) => {
  const seen: Seen = { method: "", path: "", query: "", body: "" };
  newServer(async (req) => {
    const url = new URL(req.url);
    Object.assign(seen, { method: req.method, path: url.pathname, query: url.search.replace(/^\?/, ""), body: await req.text() });
    return new Response(reply, { headers: { "content-type": "application/json" } });
  });
  return seen;
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail, and it succeeded");
};

const TIME = "2026-09-30T00:00:00.000Z";
const taskReply = (extra = "") =>
  `{"id":"t1","projectId":"p1","title":"x","status":"to-do","priority":"medium","createdAt":"${TIME}"${extra}}`;

const columnReply = `{"id":"c1","projectId":"p1","name":"Waiting","slug":"waiting","position":3,"icon":null,"color":null,"isFinal":false,"createdAt":"${TIME}","updatedAt":"${TIME}"}`;

// The stored rule a write answers with, with the two fields only the listing
// adds left for the caller to append.
const ruleRow = (extra = "") =>
  `{"id":"rule1","projectId":"p1","integrationType":"github","eventType":"pr_opened","columnId":"c1","createdAt":"${TIME}","updatedAt":"${TIME}"${extra}}`;

const emptyNewTask: api.NewTask = { title: "", description: "", priority: "", status: "", dueDate: "", assigneeId: "" };
const newTask = (t: Partial<api.NewTask>): api.NewTask => ({ ...emptyNewTask, ...t });

// The server's move route reads destinationProjectId. Sending anything else is
// a 400, which is how the hand-written client failed before.
test("TestMoveTaskSendsTheDestinationProject", async () => {
  const seen = recorder("{}");
  await api.moveTask("t1", "p2");
  expect([seen.method, seen.path]).toEqual(["PUT", "/api/task/move/t1"]);
  expect(seen.body).toBe('{"destinationProjectId":"p2"}');
});

// userId is required: null unassigns, so it must be sent, not left out.
test.each([
  ["", '{"userId":null}'],
  ["u1", '{"userId":"u1"}'],
])("TestSetTaskAssigneeSendsNullToUnassign (%j)", async (userId, want) => {
  const seen = recorder("{}");
  await api.setTaskAssignee("t1", userId);
  expect(seen.body).toBe(want);
});

// The create route takes the assignee as userId; an assigneeId key is ignored.
test("TestCreateTaskSendsTheAssigneeAsUserID", async () => {
  const seen = recorder(taskReply(',"userId":"u1"'));
  const got = await api.createTask("p1", newTask({ title: "x", assigneeId: "u1" }));
  const sent = JSON.parse(seen.body);
  expect(sent.userId).toBe("u1");
  expect("assigneeId" in sent).toBe(false);
  expect(got.assigneeId).toBe("u1");
});

// The generated client puts path values in as they are, so an id holding a
// separator must be escaped before it gets there.
test("TestPathValuesAreEscaped", async () => {
  const seen = recorder(taskReply());
  await api.getTask("a/b?c");
  expect(seen.path).toBe("/api/task/a%2Fb%3Fc");
  expect(seen.query).toBe("");
});

// Failures keep the server's message and name the full path, so the path in an
// error can be tried with curl as it is.
test("TestGeneratedCallFailuresKeepTheServerMessage", async () => {
  newServer(
    () =>
      new Response('{"success":false,"error":{"message":"Invalid key: Expected \\"destinationProjectId\\""}}', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  const err = await failure(api.moveTask("t1", "p2"));
  expect(err).toBeInstanceOf(KaneoApiError);
  const e = err as KaneoApiError;
  expect(e.statusCode).toBe(400);
  expect(e.path).toBe("/api/task/move/t1");
  expect(e.messages).toEqual(['Invalid key: Expected "destinationProjectId"']);
});

// The server sends an HTTPException as a plain-text body. A short line of it is
// the message, the way an envelope's would be; markup, other JSON, several lines
// or a long body stay a body only. The first case is the transport's trim.
test.each([
  ["Workspace ID could not be determined\n", ["Workspace ID could not be determined"]],
  ["<html><body>Bad Gateway</body></html>", []],
  ['{"message":"Internal Server Error"}', []],
  ['["x"]', []],
  ["first line\nsecond line", []],
  ["x".repeat(201), []],
  ["x".repeat(200), ["x".repeat(200)]],
  ["", []],
])("TestPlainTextFailuresCarryTheirMessage (%#)", async (body, want) => {
  newServer(() => new Response(body, { status: 400, headers: { "content-type": "text/plain;charset=UTF-8" } }));
  const err = await failure(api.getBoard("p1"));
  expect(err).toBeInstanceOf(KaneoApiError);
  expect((err as KaneoApiError).messages).toEqual(want);
});

const boardPage = (page: number, pages: number, related: number, relatedPages: number, columns: unknown[]) =>
  JSON.stringify({
    data: { id: "p1", name: "Board", slug: "b", workspaceId: "w", columns, archivedTasks: [], plannedTasks: [] },
    pagination: { total: 3, page, pageSize: 2, totalPages: pages, relatedPage: related, relatedPageSize: 100, relatedTotalPages: relatedPages },
  });

const boardTask = (id: string, n: number, labels: unknown[]) => ({
  id,
  title: id,
  number: n,
  status: "to-do",
  priority: "low",
  createdAt: TIME,
  projectId: "p1",
  subtaskCounts: { completed: 0, total: 0 },
  labels,
  externalLinks: [
    { id: "l", taskId: id, resourceType: "issue", externalId: "1", url: "u", metadata: { state: "open" }, createdAt: TIME, updatedAt: TIME },
  ],
});

const label = (id: string) => ({ id, name: id, color: "#000" });

// The server renders every column of the board on every page.
const columns = (todo: unknown[]) => [
  { id: "to-do", slug: "to-do", name: "To Do", isFinal: false, tasks: todo },
  { id: "done", slug: "done", name: "Done", isFinal: true, tasks: [] },
];

// The board is paged twice over: task pages, and within each, related pages
// that repeat the same tasks with the next labels. Every page of both is read,
// a task repeated on a related page gains its labels, and a task repeated on a
// later task page is kept once.
test("TestGetBoardReadsEveryPage", async () => {
  const queries: string[] = [];
  newServer((req) => {
    const url = new URL(req.url);
    queries.push(url.search.replace(/^\?/, ""));
    const page = url.searchParams.get("page") ?? "";
    const related = url.searchParams.get("relatedPage") ?? "";
    let reply: string;
    if (page === "" && related === "") {
      reply = boardPage(1, 2, 1, 2, columns([boardTask("t1", 1, [label("a")]), boardTask("t2", 2, [])]));
    } else if (page === "" && related === "2") {
      // "a" again, as a board changed mid-read would send it.
      reply = boardPage(1, 2, 2, 2, columns([boardTask("t1", 1, [label("b"), label("a")]), boardTask("t2", 2, [])]));
    } else if (page === "2" && related === "") {
      // t2 again, as a page boundary that moved would repeat it. Its label here
      // must not be added: this is not a related page.
      reply = boardPage(2, 2, 1, 1, columns([boardTask("t2", 2, [label("z")]), boardTask("t3", 3, [])]));
    } else {
      return new Response(`unexpected query ${url.search}`, { status: 500 });
    }
    return new Response(reply, { headers: { "content-type": "application/json" } });
  });

  const b = await api.getBoard("p1");
  // The first request asks for no page: a pre-v2.26.0 server starts paging,
  // unstably, as soon as one is named.
  expect(queries.join("|")).toBe("|relatedPage=2|page=2");
  expect(b.columns.map((c) => c.id)).toEqual(["to-do", "done"]);
  const todo = b.columns[0]!.tasks;
  expect(todo.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  expect(todo[0]!.labels!.map((l) => l.name)).toEqual(["a", "b"]);
  // a repeat on a later task page added no labels
  expect(todo[1]!.labels).toEqual([]);
});

// A server before v2.26.0 answers the plain request with the whole board.
test("TestGetBoardMakesOneRequestWhenThereIsOnePage", async () => {
  let calls = 0;
  newServer(() => {
    calls++;
    return new Response(
      JSON.stringify({
        data: { id: "p1", name: "Board", columns: columns([boardTask("t1", 1, [])]) },
        pagination: { total: 1, page: 1, pageSize: 1, totalPages: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  await api.getBoard("p1");
  expect(calls).toBe(1);
});

// A number lookup stops at the page holding the task, but only once that page's
// related pages are read: the task's other labels arrive there.
test("TestFindTaskByNumberReadsTheRelatedPagesOfItsPage", async () => {
  const queries: string[] = [];
  newServer((req) => {
    const url = new URL(req.url);
    queries.push(url.search.replace(/^\?/, ""));
    const related = url.searchParams.get("relatedPage") ?? "";
    if (url.searchParams.has("page")) return new Response("page 2 is not wanted", { status: 500 });
    const reply =
      related === ""
        ? boardPage(1, 2, 1, 2, columns([boardTask("t1", 1, [label("a")])]))
        : boardPage(1, 2, 2, 2, columns([boardTask("t1", 1, [label("b")])]));
    return new Response(reply, { headers: { "content-type": "application/json" } });
  });

  const t = (await api.findTaskByNumber("p1", 1)).task;
  expect(queries.join("|")).toBe("|relatedPage=2");
  expect(t!.labels!.map((l) => l.name)).toEqual(["a", "b"]);
});

// One task to a page. Each read is a list of pages, each page a task and the
// total the server reports with it; reads past the last repeat it.
const pagedBoard = (reads: { task: string; n: number; total: number }[][]) => {
  let count = 0;
  newServer((req) => {
    const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
    if (page === 1) count++;
    const read = reads[Math.min(count, reads.length) - 1]!;
    const at = read[page - 1]!;
    const body = JSON.parse(boardPage(page, read.length, 1, 1, columns([boardTask(at.task, at.n, [])])));
    body.pagination.total = at.total;
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  return () => count;
};

// A miss on a board whose total moved under the read is read again: a delete
// before the task pulls it back onto a page the read had already passed.
test("TestFindTaskByNumberRereadsAMissOnABoardThatMoved", async () => {
  // t0 is deleted after page 1 is read, so t1 moves onto page 1 and page 2
  // holds t2: the first read never sees t1.
  const reads = pagedBoard([
    [
      { task: "t0", n: 9, total: 3 },
      { task: "t2", n: 2, total: 2 },
    ],
    [
      { task: "t1", n: 1, total: 2 },
      { task: "t2", n: 2, total: 2 },
    ],
  ]);

  const t = (await api.findTaskByNumber("p1", 1)).task;
  expect(reads()).toBe(2);
  expect(t?.id).toBe("t1");
});

// A hit is answered as it is, even off a board that moved while it was read.
test("TestFindTaskByNumberDoesNotRereadAHit", async () => {
  const reads = pagedBoard([
    [
      { task: "t1", n: 1, total: 2 },
      { task: "t2", n: 2, total: 3 },
    ],
  ]);

  const t = (await api.findTaskByNumber("p1", 2)).task;
  expect(reads()).toBe(1);
  expect(t?.id).toBe("t2");
});

// A board that never settles is read three times at most, then the miss stands.
test("TestFindTaskByNumberStopsRereadingAMovingBoard", async () => {
  const reads = pagedBoard([
    [
      { task: "t1", n: 1, total: 2 },
      { task: "t2", n: 2, total: 3 },
    ],
  ]);

  const stderr = spyOn(console, "error").mockImplementation(() => {});
  let lines: string[];
  try {
    expect((await api.findTaskByNumber("p1", 7)).task).toBeUndefined();
    lines = stderr.mock.calls.map((c) => String(c[0]));
  } finally {
    stderr.mockRestore();
  }
  expect(reads()).toBe(3);
  expect(lines).toEqual([
    "kaneo: the board of project p1 changed while it was read; the listing may be incomplete",
  ]);
});

// archivedAt is a timestamp string, and it is printed back as the server sent it.
test("TestListProjectsReadsArchivedAt", async () => {
  recorder(
    '[{"id":"p1","workspaceId":"w","slug":"s","name":"n","createdAt":"2026-09-07T00:47:08.628Z","archivedAt":"2026-09-07T00:47:08.620Z","position":1,"lastTaskNumber":0,"statistics":{"completionPercentage":0,"totalTasks":0},"archivedTasks":[],"plannedTasks":[],"columns":[]}]',
  );
  const got = await api.listProjectsIn("w", true);
  expect(got).toHaveLength(1);
  expect(got[0]!.archivedAt).toBe("2026-09-07T00:47:08.620Z");
});

// The author's name arrives nested under user.
test("TestListCommentsReadsTheAuthorName", async () => {
  recorder(
    `[{"id":"c1","taskId":"t1","userId":"u1","content":"hi","createdAt":"${TIME}","updatedAt":"${TIME}","user":{"name":"Claude","image":null}}]`,
  );
  const got = await api.listComments("t1");
  expect(got).toHaveLength(1);
  expect(got[0]!.userName).toBe("Claude");
  expect(got[0]!.createdAt).toBe(TIME);
});

const activityRow = (id: string, at: string, extra = "") =>
  `{"id":"${id}","taskId":"t1","type":"comment","createdAt":"${at}","updatedAt":"${at}","userId":"u1","content":"hi","externalUserName":null,"externalUserAvatar":null,"externalSource":null,"externalUrl":null${extra}}`;

const comment = (id: string): api.Comment => ({ id, content: "old", userId: "u1", userName: "Ada", createdAt: TIME });

// The reply has no author name, so the edit keeps the one the listing gave.
test("TestEditCommentKeepsTheListedAuthor", async () => {
  const seen = recorder(activityRow("c1", TIME, ',"content":"new text"').replace('"content":"hi",', ""));
  const got = await api.editComment(comment("c1"), "new text");
  expect([seen.method, seen.path]).toEqual(["PUT", "/api/comment/c1"]);
  expect(JSON.parse(seen.body)).toEqual({ content: "new text" });
  expect(got).toEqual({ id: "c1", content: "new text", userId: "u1", userName: "Ada", createdAt: TIME });
});

// A write the server did not echo back did not happen: an empty 2xx, or a reply
// holding the old text, is a failure rather than an edit or a recorded event.
test("TestUnechoedWritesFail", async () => {
  recorder("");
  expect(String(await failure(api.editComment(comment("c1"), "new text")))).toContain("did not echo");
  expect(String(await failure(api.addActivity("t1", "note", "", null)))).toContain("did not echo");

  recorder(activityRow("c1", TIME));
  expect(String(await failure(api.editComment(comment("c1"), "new text")))).toContain("did not echo");

  recorder(activityRow("c2", TIME, ',"content":"new text"').replace('"content":"hi",', ""));
  expect(String(await failure(api.editComment(comment("c1"), "new text")))).toContain("did not echo");

  // A row for another task or of another type is not the event that was sent.
  recorder(activityRow("a1", TIME));
  expect(String(await failure(api.addActivity("t1", "note", "", null)))).toContain("did not echo");
  recorder(activityRow("a1", TIME).replace('"type":"comment"', '"type":"note"'));
  expect(String(await failure(api.addActivity("t2", "note", "", null)))).toContain("did not echo");
  recorder(activityRow("", TIME).replace('"type":"comment"', '"type":"note"'));
  expect(String(await failure(api.addActivity("t1", "note", "", null)))).toContain("did not echo");
});

// The server sends the feed newest first; the CLI reads it oldest first, like comments.
test("TestListActivitiesIsOldestFirst", async () => {
  recorder(`[${activityRow("new", "2026-09-30T00:00:02.000Z")},${activityRow("old", "2026-09-30T00:00:01.000Z", ',"eventData":{"a":1}')}]`);
  const got = await api.listActivities("t1");
  expect(got.map((a) => a.id)).toEqual(["old", "new"]);
  expect(got[0]!.eventData).toEqual({ a: 1 });
});

// message is required but nullable: an event without one sends null, not "" or nothing.
test("TestAddActivitySendsAnEmptyMessageAsNull", async () => {
  let seen = recorder(activityRow("a1", TIME).replace('"type":"comment"', '"type":"status_changed"'));
  await api.addActivity("t1", "status_changed", "", { newStatus: "done" });
  expect(JSON.parse(seen.body)).toEqual({ taskId: "t1", type: "status_changed", message: null, eventData: { newStatus: "done" } });

  seen = recorder(activityRow("a1", TIME).replace('"type":"comment"', '"type":"note"').replace('"content":"hi"', '"content":"hello"'));
  const got = await api.addActivity("t1", "note", "hello", null);
  expect(JSON.parse(seen.body)).toEqual({ taskId: "t1", type: "note", message: "hello", eventData: null });
  expect(got).toEqual({ id: "a1", type: "note", content: "hello", eventData: null, userId: "u1", createdAt: TIME });
});

// A 201 or 204 is a success like 200. Reported as a failure, a write that
// happened invites a retry that duplicates it.
test("TestAnyTwoHundredIsASuccess", async () => {
  newServer(() => new Response(taskReply(), { status: 201, headers: { "content-type": "application/json" } }));
  const got = await api.createTask("p1", newTask({ title: "x" }));
  expect([got.id, got.projectId, got.title]).toEqual(["t1", "p1", "x"]);

  newServer(() => new Response(null, { status: 204 }));
  await api.deleteTask("t1");
});

// Every call reaches its own route, with the id escaped. The method and the
// whole path are compared, so a wrapper calling a sibling operation fails.
describe("TestEveryCallHitsItsRouteWithTheIDEscaped", () => {
  const id = "a/b";
  const calls: [string, string, string, () => Promise<unknown>][] = [
    ["GetProject", "GET", "/api/project/a%2Fb", () => api.getProject(id)],
    ["Archive", "PUT", "/api/project/a%2Fb/archive", () => api.setProjectArchived(id, true)],
    ["Unarchive", "PUT", "/api/project/a%2Fb/unarchive", () => api.setProjectArchived(id, false)],
    ["ListColumns", "GET", "/api/column/a%2Fb", () => api.listColumns(id)],
    ["CreateColumn", "POST", "/api/column/a%2Fb", () => api.createColumn(id, { name: "n", icon: "", color: "", isFinal: false })],
    ["ReorderColumns", "PUT", "/api/column/reorder/a%2Fb", () => api.reorderColumns(id, [id])],
    ["RenameColumn", "PUT", "/api/column/a%2Fb", () => api.renameColumn(id, "n")],
    ["DeleteColumn", "DELETE", "/api/column/a%2Fb", () => api.deleteColumn(id)],
    ["DeleteProject", "DELETE", "/api/project/a%2Fb", () => api.deleteProject(id)],
    ["ReorderProjects", "PUT", "/api/project/reorder", () => api.reorderProjects(id, [id])],
    ["ListWorkflowRules", "GET", "/api/workflow-rule/a%2Fb", () => api.listWorkflowRules(id)],
    ["SetWorkflowRule", "PUT", "/api/workflow-rule/a%2Fb", () => api.setWorkflowRule(id, { integrationType: "i", eventType: "e", columnId: "c" })],
    ["DeleteWorkflowRule", "DELETE", "/api/workflow-rule/a%2Fb", () => api.deleteWorkflowRule(id)],
    ["ListExternalLinks", "GET", "/api/external-link/task/a%2Fb", () => api.listExternalLinks(id)],
    ["GetBoard", "GET", "/api/task/tasks/a%2Fb", () => api.getBoard(id)],
    ["GetTask", "GET", "/api/task/a%2Fb", () => api.getTask(id)],
    ["SetTaskStatus", "PUT", "/api/task/status/a%2Fb", () => api.setTaskStatus(id, "x")],
    ["SetTaskPriority", "PUT", "/api/task/priority/a%2Fb", () => api.setTaskPriority(id, "low")],
    ["SetTaskAssignee", "PUT", "/api/task/assignee/a%2Fb", () => api.setTaskAssignee(id, "")],
    ["MoveTask", "PUT", "/api/task/move/a%2Fb", () => api.moveTask(id, "p")],
    ["DeleteTask", "DELETE", "/api/task/a%2Fb", () => api.deleteTask(id)],
    ["CreateTask", "POST", "/api/task/a%2Fb", () => api.createTask(id, newTask({}))],
    ["ListComments", "GET", "/api/comment/a%2Fb", () => api.listComments(id)],
    ["AddComment", "POST", "/api/comment/a%2Fb", () => api.addComment(id, "x")],
    ["DeleteComment", "DELETE", "/api/comment/a%2Fb", () => api.deleteComment(id)],
    ["EditComment", "PUT", "/api/comment/a%2Fb", () => api.editComment(comment(id), "x")],
    ["ListActivities", "GET", "/api/activity/a%2Fb", () => api.listActivities(id)],
    ["AddActivity", "POST", "/api/activity/create", () => api.addActivity(id, "x", "", null)],
    ["ListRelations", "GET", "/api/task-relation/a%2Fb", () => api.listRelations(id)],
    ["LinkTasks", "POST", "/api/task-relation", () => api.linkTasks("s", "d", "blocks")],
    ["DeleteRelation", "DELETE", "/api/task-relation/a%2Fb", () => api.deleteRelation(id)],
    ["CreateProject", "POST", "/api/project", () => api.createProject({ name: "n", workspaceId: "w", icon: "", slug: "" })],
    ["ListTimeEntries", "GET", "/api/time-entry/task/a%2Fb", () => api.listTimeEntries(id)],
    ["GetTimeEntry", "GET", "/api/time-entry/a%2Fb", () => api.getTimeEntryById(id)],
    ["UpdateTimeEntry", "PUT", "/api/time-entry/a%2Fb", () => api.updateTimeEntryById(id, { startTime: TIME })],
    ["AddTimeEntry", "POST", "/api/time-entry", () => api.addTimeEntry(id, { startTime: TIME, description: "" })],
    ["ListProjects", "GET", "/api/project", () => api.listProjectsIn("w", false)],
    ["ListWorkspaces", "GET", "/api/auth/organization/list", () => api.listWorkspaces()],
    ["ListWorkspaceLabels", "GET", "/api/label/workspace/a%2Fb", () => api.listWorkspaceLabels(id)],
    ["ListTaskLabels", "GET", "/api/label/task/a%2Fb", () => api.listTaskLabels(id)],
    ["GetLabel", "GET", "/api/label/a%2Fb", () => api.getLabel(id)],
    ["CreateLabel", "POST", "/api/label", () => api.createLabel("w", "bug", "red")],
    ["DeleteLabel", "DELETE", "/api/label/a%2Fb", () => api.deleteLabel(id)],
    ["AttachLabel", "PUT", "/api/label/a%2Fb/task", () => api.attachLabel(id, "t")],
    ["DetachLabel", "DELETE", "/api/label/a%2Fb/task", () => api.detachLabel(id)],
  ];
  test.each(calls)("%s", async (name, method, path, call) => {
    const seen: { method: string; path: string }[] = [];
    newServer((req) => {
      seen.push({ method: req.method, path: new URL(req.url).pathname });
      return new Response(null, { status: 204 });
    });
    // An empty reply is an error for the board, which must name a project, and
    // for the writes that must echo what they wrote; a success for everything else.
    const err = await call().then(
      () => undefined,
      (e) => e,
    );
    expect(err !== undefined, `${name}: err = ${err}`).toBe(
      ["GetBoard", "EditComment", "AddActivity", "AddTimeEntry", "UpdateTimeEntry"].includes(name),
    );
    expect(seen[0]).toEqual({ method, path });
  });
});

const LABEL = (extra = "") =>
  `{"id":"l1","name":"bug","color":"red","createdAt":"${TIME}","updatedAt":"${TIME}","taskId":null,"workspaceId":"w1"${extra}}`;

// A workspace label's deletion goes on in batches: the server answers 202 with
// pendingDeletion until the last one, and the same request has to be repeated
// until it answers 200, or the label and its remaining task copies stay.
test("TestDeleteLabelRepeatsUntilTheServerIsDone", async () => {
  let calls = 0;
  newServer((req) => {
    calls++;
    expect([req.method, new URL(req.url).pathname]).toEqual(["DELETE", "/api/label/l1"]);
    return calls < 3
      ? new Response(LABEL(`,"pendingDeletion":true`), { status: 202, headers: { "content-type": "application/json" } })
      : new Response(LABEL(), { headers: { "content-type": "application/json" } });
  });
  const got = await api.deleteLabel("l1");
  expect(calls).toBe(3);
  expect(got.id).toBe("l1");
});

// The server's update replaces name and color together, so a change to one
// sends the other back as it was read.
test("TestUpdateLabelKeepsTheFieldNotAsked", async () => {
  const sent: string[] = [];
  newServer(async (req) => {
    if (req.method === "PUT") sent.push(await req.text());
    return new Response(LABEL(), { headers: { "content-type": "application/json" } });
  });
  await api.updateLabel("l1", { color: "green" });
  await api.updateLabel("l1", { name: "defect" });
  expect(sent.map((s) => JSON.parse(s))).toEqual([
    { name: "bug", color: "green" },
    { name: "defect", color: "red" },
  ]);
});

// A busy server (429) is waited out, and the count of retries starts over
// after a batch that went through: five busy answers, a batch, one more busy
// answer and the end is a deletion that finishes, not one given up on.
test("TestDeleteLabelWaitsOutABusyServer", async () => {
  const replies = [429, 429, 429, 429, 429, 202, 429, 200];
  let calls = 0;
  newServer(() => {
    const status = replies[calls++]!;
    if (status === 429) return new Response("Label deletion is busy; retry this request", { status, headers: { "Retry-After": "1" } });
    return new Response(LABEL(status === 202 ? `,"pendingDeletion":true` : ""), { status, headers: { "content-type": "application/json" } });
  });
  expect((await api.deleteLabel("l1")).id).toBe("l1");
  expect(calls).toBe(8);
}, 15_000);

// Five busy answers in a row are given up on, so a server that stays busy
// does not hold the command until its deadline.
test("TestDeleteLabelGivesUpOnAServerThatStaysBusy", async () => {
  let calls = 0;
  newServer(() => {
    calls++;
    return new Response("busy", { status: 429 });
  });
  const err = await failure(api.deleteLabel("l1"));
  expect(err).toBeInstanceOf(KaneoApiError);
  expect(calls).toBe(6);
}, 10_000);

// The server starts deleting inside the first request, so any failure but a
// refusal (4xx) on the first request may have left the label partly deleted,
// and says how to finish it. The failure keeps its type, so a caller can
// still read the status.
test("TestDeleteLabelSaysAPartialDeletionResumes", async () => {
  for (const [replies, partly] of [[[202, 500], true], [[500], true], [[403], false]] as const) {
    let calls = 0;
    newServer(() => {
      const status = replies[calls++]!;
      return status === 202
        ? new Response(LABEL(`,"pendingDeletion":true`), { status, headers: { "content-type": "application/json" } })
        : new Response("boom", { status });
    });
    const err = await failure(api.deleteLabel("l1"));
    expect(err).toBeInstanceOf(KaneoApiError);
    expect((err as KaneoApiError).statusCode).toBe(replies.at(-1)!);
    expect(String(err).includes("run `kaneo label rm l1 --yes` again")).toBe(partly);
  }
});

// Another client can finish the same deletion while this one waits out a
// busy answer; the label is then gone and the server cannot place its id.
// That is the deletion done, not a failure.
test("TestDeleteLabelTakesAGoneLabelAfterABatchAsDone", async () => {
  for (const gone of [400, 404]) {
    const replies = [202, gone];
    let calls = 0;
    newServer(() => {
      const status = replies[calls++]!;
      return status === 202
        ? new Response(LABEL(`,"pendingDeletion":true`), { status, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ message: "Workspace ID could not be determined" }), { status });
    });
    expect((await api.deleteLabel("l1")).id).toBe("l1");
    expect(calls).toBe(2);
  }
  // Before any batch, the same answer is an unknown label and fails.
  newServer(() => new Response("unknown", { status: 400 }));
  expect(await failure(api.deleteLabel("l1"))).toBeInstanceOf(KaneoApiError);
});

// The PUT goes to the label's own route with its id escaped, like every
// other call; it is not in the table above because it reads first.
test("TestUpdateLabelWritesToItsRouteWithTheIDEscaped", async () => {
  const seen: string[] = [];
  newServer((req) => {
    seen.push(`${req.method} ${new URL(req.url).pathname}`);
    return new Response(LABEL().replace('"id":"l1"', '"id":"a/b"'), { headers: { "content-type": "application/json" } });
  });
  await api.updateLabel("a/b", { color: "green" });
  expect(seen).toEqual(["GET /api/label/a%2Fb", "PUT /api/label/a%2Fb"]);
});

// A read that answers a different label must not be written over this one.
test("TestUpdateLabelRefusesAReadOfAnotherLabel", async () => {
  const methods: string[] = [];
  newServer((req) => {
    methods.push(req.method);
    return new Response(LABEL().replace('"id":"l1"', '"id":"l2"'), { headers: { "content-type": "application/json" } });
  });
  expect(String(await failure(api.updateLabel("l1", { color: "green" })))).toContain("not writing");
  expect(methods).toEqual(["GET"]);
});

// A blank color would leave a label the web app draws in its fallback grey.
test("TestLabelColorMustNotBeBlank", async () => {
  const methods: string[] = [];
  newServer((req) => {
    methods.push(req.method);
    return new Response(LABEL(), { headers: { "content-type": "application/json" } });
  });
  expect(String(await failure(api.createLabel("w", "bug", " ")))).toContain("label color is empty");
  expect(String(await failure(api.updateLabel("l1", { color: "" })))).toContain("label color is empty");
  expect(methods).toEqual([]);
});

// A read that came back empty must not be written back as a blank label.
test("TestUpdateLabelRefusesAnEmptyRead", async () => {
  const methods: string[] = [];
  newServer((req) => {
    methods.push(req.method);
    return new Response(null, { status: 204 });
  });
  expect(String(await failure(api.updateLabel("l1", { color: "green" })))).toContain("not writing");
  expect(methods).toEqual(["GET"]);
});

// What each read maps onto the CLI's types, field by field.
describe("TestReadsMapEveryField", () => {
  test("board task", async () => {
    recorder(
      `{"data":{"id":"p1","name":"B","columns":[{"id":"to-do","name":"To Do","tasks":[` +
        `{"id":"t1","title":"T","number":7,"description":"D","status":"to-do","priority":"high","position":3,"projectId":"p1",` +
        `"assigneeId":"u1","assigneeName":"Ann","startDate":"2026-09-01T00:00:00.000Z","dueDate":"2026-10-01T00:00:00.000Z","createdAt":"${TIME}",` +
        `"subtaskCounts":{"completed":0,"total":0},"labels":[{"id":"l1","name":"bug","color":"#f00"}],"externalLinks":[]}]}]},"pagination":{"totalPages":1}}`,
    );
    const b = await api.getBoard("p1");
    expect(b.columns[0]!.tasks[0]).toEqual({
      id: "t1",
      number: 7,
      title: "T",
      description: "D",
      status: "to-do",
      priority: "high",
      position: 3,
      projectId: "p1",
      assigneeId: "u1",
      assigneeName: "Ann",
      startDate: "2026-09-01T00:00:00.000Z",
      dueDate: "2026-10-01T00:00:00.000Z",
      createdAt: TIME,
      labels: [{ id: "l1", name: "bug", color: "#f00" }],
    });
  });

  test("task", async () => {
    recorder(
      `{"id":"t1","projectId":"p1","number":7,"title":"T","status":"s","priority":"low","createdAt":"${TIME}",` +
        `"assigneeId":"u1","assigneeName":"Ann","dueDate":"2026-10-01T00:00:00.000Z"}`,
    );
    const got = await api.getTask("t1");
    expect([got.number, got.assigneeId, got.assigneeName, got.dueDate]).toEqual([7, "u1", "Ann", "2026-10-01T00:00:00.000Z"]);
  });

  // The listing answers with a summary of each linked task, which is what a link
  // is reported by number from; a server that sends none leaves them null.
  test("relations", async () => {
    recorder(
      `[{"id":"r1","sourceTaskId":"s","targetTaskId":"d","relationType":"blocks","createdAt":"${TIME}",` +
        `"sourceTask":{"id":"s","title":"S","status":"to-do","isCompleted":false,"priority":"low","number":7,"projectId":"p1","userId":null,"assigneeName":null},` +
        `"targetTask":null},` +
        `{"id":"r2","sourceTaskId":"s","targetTaskId":"e","relationType":"related","createdAt":"${TIME}",` +
        `"sourceTask":{"id":"s","title":"S","status":"to-do","number":7,"projectId":"p1"},` +
        `"targetTask":{"id":"e","title":"E","status":"done","number":null,"projectId":"p1"}}]`,
    );
    expect(await api.listRelations("s")).toEqual([
      {
        id: "r1",
        sourceTaskId: "s",
        targetTaskId: "d",
        relationType: "blocks",
        sourceTask: { id: "s", number: 7, title: "S", status: "to-do", projectId: "p1" },
        targetTask: null,
      },
      {
        id: "r2",
        sourceTaskId: "s",
        targetTaskId: "e",
        relationType: "related",
        sourceTask: { id: "s", number: 7, title: "S", status: "to-do", projectId: "p1" },
        targetTask: { id: "e", number: null, title: "E", status: "done", projectId: "p1" },
      },
    ]);
  });

  test("deleted relation", async () => {
    const seen = recorder(
      `{"id":"r1","sourceTaskId":"s","targetTaskId":"d","relationType":"blocks","createdAt":"${TIME}"}`,
    );
    const removed = await api.deleteRelation("r1");
    expect([seen.method, seen.path]).toEqual(["DELETE", "/api/task-relation/r1"]);
    expect(removed).toEqual({ id: "r1", sourceTaskId: "s", targetTaskId: "d", relationType: "blocks", sourceTask: null, targetTask: null });
  });

  // icon and color are nullable on the wire, and a column carries neither.
  test("column", async () => {
    recorder(`[${columnReply}]`);
    expect(await api.listColumns("p1")).toEqual([
      { id: "c1", slug: "waiting", name: "Waiting", position: 3, isFinal: false, icon: null, color: null },
    ]);
  });

  test("column with an icon and a color", async () => {
    recorder(`[${columnReply.replace('"icon":null,"color":null', () => '"icon":"Clock","color":"#f00"')}]`);
    expect(await api.listColumns("p1")).toEqual([
      { id: "c1", slug: "waiting", name: "Waiting", position: 3, isFinal: false, icon: "Clock", color: "#f00" },
    ]);
  });

  test("added comment", async () => {
    const seen = recorder(
      `{"id":"c1","taskId":"t1","type":"comment","content":"hi","userId":"u1","createdAt":"${TIME}","updatedAt":"${TIME}"}`,
    );
    const got = await api.addComment("t1", "hi");
    expect(seen.body).toBe('{"content":"hi"}');
    expect([got.id, got.content, got.userId]).toEqual(["c1", "hi", "u1"]);
  });

  test("workflow rule", async () => {
    recorder(`[${ruleRow(',"columnName":"In Progress","columnSlug":"in-progress"')}]`);
    expect(await api.listWorkflowRules("p1")).toEqual([
      {
        id: "rule1",
        projectId: "p1",
        integrationType: "github",
        eventType: "pr_opened",
        columnId: "c1",
        columnName: "In Progress",
        columnSlug: "in-progress",
        createdAt: TIME,
        updatedAt: TIME,
      },
    ]);
  });

  test("workflow rule without a column found", async () => {
    recorder(`[${ruleRow(",\"columnName\":null,\"columnSlug\":null")}]`);
    const got = await api.listWorkflowRules("p1");
    expect([got[0]!.columnName, got[0]!.columnSlug, got[0]!.columnId]).toEqual([null, null, "c1"]);
  });

  test("workflow rule row", async () => {
    const seen = recorder(ruleRow());
    const got = await api.setWorkflowRule("p1", { integrationType: "github", eventType: "pr_opened", columnId: "c1" });
    expect([seen.method, seen.path]).toEqual(["PUT", "/api/workflow-rule/p1"]);
    expect(seen.body).toBe('{"integrationType":"github","eventType":"pr_opened","columnId":"c1"}');
    expect(got).toEqual({
      id: "rule1",
      projectId: "p1",
      integrationType: "github",
      eventType: "pr_opened",
      columnId: "c1",
      createdAt: TIME,
      updatedAt: TIME,
    });
  });

  // The integration is what tells a link added by hand from one an integration
  // brought in, and its type is read off the nested row.
  test("external links", async () => {
    recorder(
      `[{"id":"l1","taskId":"t1","integrationId":"int-1","resourceType":"pull_request","externalId":"7","url":"https://example.com/pull/7","title":null,"metadata":null,"createdAt":"${TIME}","updatedAt":"${TIME}","integration":{"id":"int-1","type":"github"}},` +
        `{"id":"l2","taskId":"t1","integrationId":null,"resourceType":"url","externalId":"https://example.com/spec","url":"https://example.com/spec","title":"Spec","metadata":null,"createdAt":"${TIME}","updatedAt":"${TIME}","integration":null}]`,
    );
    expect(await api.listExternalLinks("t1")).toEqual([
      {
        id: "l1",
        taskId: "t1",
        resourceType: "pull_request",
        externalId: "7",
        url: "https://example.com/pull/7",
        title: null,
        integrationType: "github",
        createdAt: TIME,
        updatedAt: TIME,
      },
      {
        id: "l2",
        taskId: "t1",
        resourceType: "url",
        externalId: "https://example.com/spec",
        url: "https://example.com/spec",
        title: "Spec",
        integrationType: null,
        createdAt: TIME,
        updatedAt: TIME,
      },
    ]);
  });
});

// What each write puts on the wire.
describe("TestWritesSendEveryField", () => {
  test("create task", async () => {
    const seen = recorder(taskReply());
    await api.createTask("p1", newTask({ title: "x", description: "d", priority: "high", status: "review", dueDate: "2026-10-01" }));
    expect(seen.body).toBe('{"title":"x","description":"d","dueDate":"2026-10-01","priority":"high","status":"review"}');
  });

  test("create task defaults", async () => {
    const seen = recorder(taskReply());
    await api.createTask("p1", newTask({ title: "x" }));
    expect(seen.body).toBe('{"title":"x","description":"","priority":"medium","status":"to-do"}');
  });

  // The slug comes from the name, so it is not sent, and an icon and a color are
  // left out of the body when there are none: the route takes a string or
  // nothing, never null.
  test("create column", async () => {
    const seen = recorder(columnReply);
    await api.createColumn("p1", { name: "Waiting", icon: "", color: "", isFinal: false });
    expect(seen.body).toBe('{"name":"Waiting","isFinal":false}');
  });

  test("create column with an icon, a color and a done state", async () => {
    const seen = recorder(columnReply);
    await api.createColumn("p1", { name: "Waiting", icon: "Clock", color: "#f00", isFinal: true });
    expect(seen.body).toBe('{"name":"Waiting","isFinal":true,"icon":"Clock","color":"#f00"}');
  });

  // A rename sends the name and nothing else, so a column keeps the slug its
  // tasks store as their status.
  test("rename column", async () => {
    const seen = recorder(columnReply);
    await api.renameColumn("c1", "Doing");
    expect(seen.body).toBe('{"name":"Doing"}');
  });

  // The whole new order in one request, numbered from zero.
  test("reorder columns", async () => {
    const seen = recorder(`[${columnReply}]`);
    const columns = await api.reorderColumns("p1", ["c1", "c2", "c3"]);
    expect(seen.body).toBe('{"columns":[{"id":"c1","position":0},{"id":"c2","position":1},{"id":"c3","position":2}]}');
    expect(columns.map((c) => c.slug)).toEqual(["waiting"]);
  });

  test.each([
    [false, "workspaceId=w"],
    [true, "includeArchived=true&workspaceId=w"],
  ])("list projects (archived=%p)", async (archived, want) => {
    const seen = recorder("[]");
    await api.listProjectsIn("w", archived);
    expect(seen.query).toBe(want);
  });

  test("link", async () => {
    const seen = recorder(`{"id":"r1","sourceTaskId":"s","targetTaskId":"d","relationType":"subtask","createdAt":"${TIME}"}`);
    const got = await api.linkTasks("s", "d", "subtask");
    expect(seen.body).toBe('{"sourceTaskId":"s","targetTaskId":"d","relationType":"subtask"}');
    expect([got.sourceTaskId, got.targetTaskId]).toEqual(["s", "d"]);
  });
});

// A write's reply is mapped in full, and a number past float32's exact range
// comes through unchanged.
test("TestWriteReplyMapsEveryField", async () => {
  recorder(
    `{"id":"t1","projectId":"p1","number":16777217,"position":16777219,"title":"x","description":"d","status":"s","priority":"low",` +
      `"userId":"u1","startDate":"2026-09-01T00:00:00.000Z","dueDate":"2026-10-01T00:00:00.000Z","createdAt":"2026-09-30T00:00:00.123Z"}`,
  );
  const got = await api.createTask("p1", newTask({ title: "x" }));
  expect(got).toMatchObject({
    id: "t1",
    projectId: "p1",
    number: 16777217,
    position: 16777219,
    title: "x",
    description: "d",
    status: "s",
    priority: "low",
    assigneeId: "u1",
    startDate: "2026-09-01T00:00:00.000Z",
    dueDate: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-09-30T00:00:00.123Z",
  });
});

// updateProject reads and writes the same escaped route.
test("TestUpdateProjectEscapesTheID", async () => {
  const paths: string[] = [];
  newServer((req) => {
    paths.push(`${req.method} ${new URL(req.url).pathname}`);
    return new Response(
      `{"id":"a/b","name":"New","slug":"s","icon":"Box","description":"d","createdAt":"${TIME}","position":1,"lastTaskNumber":0}`,
      { headers: { "content-type": "application/json" } },
    );
  });
  await api.updateProject("a/b", { name: "New" });
  expect(paths.join(", ")).toBe("GET /api/project/a%2Fb, PUT /api/project/a%2Fb");
});

describe("time entries", () => {
  const entry = (id: string, extra = "") =>
    `{"id":"${id}","taskId":"t1","userId":"u1","description":"d","startTime":"${TIME}","endTime":null,"duration":null,"createdAt":"${TIME}","updatedAt":"${TIME}"${extra}}`;

  // An update without a start reads it back; a read that decoded to nothing, or
  // to another entry, must not be written back as the start.
  test.each([
    ["an empty reply", "{}"],
    ["another entry", entry("other")],
    ["the entry with no start", entry("e1").replace(`"startTime":"${TIME}"`, '"startTime":null')],
  ])("update refuses to write back %s", async (_name, reply) => {
    const seen: string[] = [];
    newServer((req) => {
      seen.push(req.method);
      return new Response(reply, { headers: { "content-type": "application/json" } });
    });
    const err = await failure(api.updateTimeEntryById("e1", { endTime: TIME }));
    expect(String(err)).toContain("not writing");
    expect(seen).toEqual(["GET"]);
  });

  test("add sends only what was given", async () => {
    const seen = recorder(entry("e1"));
    await api.addTimeEntry("t1", { startTime: TIME, description: "" });
    expect(JSON.parse(seen.body)).toEqual({ taskId: "t1", startTime: TIME });
    await api.addTimeEntry("t1", { startTime: TIME, endTime: TIME, description: "d" });
    expect(JSON.parse(seen.body)).toEqual({ taskId: "t1", startTime: TIME, endTime: TIME, description: "d" });
  });

  test("update sends the start and only the changed fields", async () => {
    const seen = recorder(entry("e1"));
    await api.updateTimeEntryById("e1", { startTime: TIME, description: "" });
    expect(JSON.parse(seen.body)).toEqual({ startTime: TIME, description: "" });
  });

  // A write the server did not echo is not reported as done.
  test.each([
    ["add, empty reply", () => api.addTimeEntry("t1", { startTime: TIME, description: "" }), "{}"],
    ["update, empty reply", () => api.updateTimeEntryById("e1", { startTime: TIME }), "{}"],
    ["update, another entry", () => api.updateTimeEntryById("e1", { startTime: TIME }), entry("other")],
  ])("%s is refused", async (_name, call, reply) => {
    recorder(reply);
    expect(String(await failure(call()))).toContain("the write is not confirmed");
  });

  test("stop reads the entry, refuses one already stopped, and ends a running one", async () => {
    let stored = entry("e1");
    const seen: string[] = [];
    newServer(async (req) => {
      seen.push(req.method);
      if (req.method === "PUT") stored = entry("e1").replace('"endTime":null', `"endTime":"${TIME}"`);
      return new Response(stored, { headers: { "content-type": "application/json" } });
    });
    expect((await api.stopTimeEntry("e1", TIME)).endTime).toBe(TIME);
    expect(String(await failure(api.stopTimeEntry("e1", TIME)))).toContain("already stopped");
    expect(seen).toEqual(["GET", "PUT", "GET"]);
  });

  // The generated schema requires userName, but a reply is not refused for
  // departing from the schema, so a server that leaves it out reads as null.
  test("a listing without userName reads as null", async () => {
    recorder(`[${entry("e1")}]`);
    expect((await api.listTimeEntries("t1"))[0]!.userName).toBeNull();
  });

  test("the list carries the user's name and the single reads do not", async () => {
    recorder(`[${entry("e1", ',"userName":"Ann"')}]`);
    expect((await api.listTimeEntries("t1"))[0]!.userName).toBe("Ann");
    recorder(entry("e1", ',"userName":"Ann"'));
    expect("userName" in (await api.getTimeEntryById("e1"))).toBe(false);
  });

  test.each([
    ["2026-01-02T09:00:00Z", true],
    ["2026-01-02T09:00+09:00", true],
    ["2026-01-02T09:00:00.123456789-05:30", true],
    ["2026-01-02T09:00:00", false],
    ["2026-01-02", false],
    ["2026-02-30T09:00:00Z", false],
    ["2026-13-01T09:00:00Z", false],
    ["", false],
    ["tomorrow", false],
  ])("checkTimestamp(%p) accepts: %p", (value, ok) => {
    const run = () => api.checkTimestamp("start", value);
    if (ok) expect(run()).toBe(value);
    else expect(run).toThrow("is not a real date and time in ISO 8601 with an offset");
  });

  test("a bad time is refused before any request", async () => {
    const seen: string[] = [];
    newServer((req) => {
      seen.push(req.method);
      return new Response("{}");
    });
    await failure(api.addTimeEntry("t1", { startTime: "2026-01-02T09:00", description: "" }));
    await failure(api.updateTimeEntryById("e1", { endTime: "" }));
    expect(seen).toEqual([]);
  });
});

// The workspace travels in the query and the order in the body; positions are
// the list's own order, which is all the server reads them as.
test("TestReorderProjectsSendsTheWorkspaceAndTheOrder", async () => {
  const seen: { query: string; body: unknown }[] = [];
  newServer(async (req) => {
    const url = new URL(req.url);
    seen.push({ query: url.search, body: await req.json() });
    return Response.json([]);
  });
  await api.reorderProjects("w/1", ["p2", "p1"]);
  expect(seen).toEqual([{ query: "?workspaceId=w%2F1", body: { projects: [{ id: "p2", position: 0 }, { id: "p1", position: 1 }] } }]);
});
