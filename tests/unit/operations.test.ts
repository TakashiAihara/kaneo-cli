import { afterEach, describe, expect, test } from "bun:test";
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
    ["ListRelations", "GET", "/api/task-relation/a%2Fb", () => api.listRelations(id)],
    ["LinkTasks", "POST", "/api/task-relation", () => api.linkTasks("s", "d", "blocks")],
    ["DeleteRelation", "DELETE", "/api/task-relation/a%2Fb", () => api.deleteRelation(id)],
    ["CreateProject", "POST", "/api/project", () => api.createProject({ name: "n", workspaceId: "w", icon: "", slug: "", description: "" })],
    ["ListProjects", "GET", "/api/project", () => api.listProjectsIn("w", false)],
    ["ListWorkspaces", "GET", "/api/auth/organization/list", () => api.listWorkspaces()],
  ];
  test.each(calls)("%s", async (name, method, path, call) => {
    const seen: { method: string; path: string }[] = [];
    newServer((req) => {
      seen.push({ method: req.method, path: new URL(req.url).pathname });
      return new Response(null, { status: 204 });
    });
    // An empty reply is an error for the board, which must name a project,
    // and a success for everything else.
    const err = await call().then(
      () => undefined,
      (e) => e,
    );
    expect(err !== undefined, `${name}: err = ${err}`).toBe(name === "GetBoard");
    expect(seen[0]).toEqual({ method, path });
  });
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
