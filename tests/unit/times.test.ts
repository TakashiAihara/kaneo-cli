import { afterEach, describe, expect, test } from "bun:test";
import { configureClient } from "../../src/api/http";
import * as api from "../../src/api/kaneo";

// What the CLI makes of the timestamps in a reply. Go decoded them into a
// time.Time, so a field it could not parse failed the decode there rather than
// becoming a timestamp, and a field the reply left out, or sent as null, became
// its zero value. Both are decided where the reply is read, so both are held
// here.

const ZERO = "0001-01-01T00:00:00.000Z";
const TIME = "2026-09-30T00:00:00.000Z";

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

// Answers every request with the body given, as the server would.
const answers = (body: string) => {
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
  servers.push(s);
  configureClient({ baseUrl: `http://127.0.0.1:${s.port}`, apiKey: "test-key" });
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail, and it succeeded");
};

// A task as the routes that answer with one send it. A field left undefined is
// left out of the body, which is how a reply that carries no such field arrives.
const taskReply = (fields: Record<string, unknown>) =>
  JSON.stringify({
    id: "t1",
    projectId: "p1",
    title: "x",
    status: "to-do",
    priority: "medium",
    createdAt: TIME,
    ...fields,
  });

describe("a createdAt in a reply", () => {
  test("is read as the instant it names, whichever offset it was written in", async () => {
    answers(taskReply({ createdAt: "2026-09-30T09:00:00+09:00" }));
    expect((await api.getTask("t1")).createdAt).toBe(TIME);
  });

  // What Go's decoder refused is a field it could not read a time out of, the
  // empty string included: there is no instant in either, and passing either on
  // says a task was created at a time nobody can name.
  test.each([
    ["", "empty"],
    ["abc", "not a date at all"],
    ["2026", "a bare year"],
    ["2026-09-30", "a date alone"],
    ["2026-09-30T00:00:00", "a time with no offset, which Date.parse reads in the local zone"],
    ["2026-09-30 00:00:00Z", "a space for the T"],
    ["2026-09-30t00:00:00z", "lower-case t and z"],
    ["2026-02-30T00:00:00Z", "a day the month does not have"],
    ["2026-02-29T00:00:00Z", "29 February in a year that is not a leap year"],
    ["2100-02-29T00:00:00Z", "29 February in a century that is not a leap year"],
    ["2026-09-30T24:00:00Z", "an hour past 23"],
    ["2026-09-30T00:60:00Z", "a minute past 59, which Date.parse refuses on its own"],
    ["2026-09-30T00:00:60Z", "a second past 59, which Date.parse refuses on its own"],
    ["2026-09-00T00:00:00Z", "day 00, which Date.parse refuses on its own"],
    ["2026-09-30T00:00:00+24:00", "an offset of 24 hours, which Go took and this does not"],
    ["2026-09-30T00:00:00,5Z", "a comma before the fraction, which Go took and this does not"],
    ["2026-09-30T0:00:00Z", "a one-digit hour, which Go took and this does not"],
    [2026, "a number"],
  ])("that is %p (%s) fails the read, naming the field", async (createdAt) => {
    answers(taskReply({ createdAt }));
    const e = (await failure(api.getTask("t1"))) as Error;
    expect(e.message).toBe(`GET /api/task/t1: createdAt ${JSON.stringify(createdAt)} is not a timestamp`);
  });

  test.each([
    ["2026-09-30T00:00:00.123456789Z", "2026-09-30T00:00:00.123Z"],
    ["2028-02-29T00:00:00Z", "2028-02-29T00:00:00.000Z"],
    ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z"],
  ])("that is %p, which Go reads, reads as %p", async (createdAt, want) => {
    answers(taskReply({ createdAt }));
    expect((await api.getTask("t1")).createdAt).toBe(want);
  });

  test("is cut between characters, not inside one", async () => {
    const smile = String.fromCodePoint(0x1f600);
    answers(taskReply({ createdAt: "x".repeat(198) + smile.repeat(5) }));
    const e = (await failure(api.getTask("t1"))) as Error;
    expect(e.message).toBe(`GET /api/task/t1: createdAt "${"x".repeat(198)}${smile}... is not a timestamp`);
  });

  test("that is longer than a message should carry is cut", async () => {
    answers(taskReply({ createdAt: "x".repeat(500) }));
    const e = (await failure(api.getTask("t1"))) as Error;
    expect(e.message).toBe(`GET /api/task/t1: createdAt "${"x".repeat(199)}... is not a timestamp`);
  });

  test.each([
    ["left out", undefined],
    ["null", null],
  ])("that is %s reads as Go's zero time", async (_what, createdAt) => {
    answers(taskReply({ createdAt }));
    expect((await api.getTask("t1")).createdAt).toBe(ZERO);
  });
});

describe("a dueDate, which may be absent", () => {
  test.each([
    ["left out", undefined, null],
    ["null", null, null],
    ["a time", TIME, TIME],
    ["a time with an offset", "2026-09-30T09:00:00+09:00", TIME],
  ])("that is %s reads as %p", async (_what, dueDate, want) => {
    answers(taskReply({ dueDate }));
    expect((await api.getTask("t1")).dueDate).toBe(want);
  });

  test("that is not a date fails the read too", async () => {
    answers(taskReply({ dueDate: "next tuesday" }));
    const e = (await failure(api.getTask("t1"))) as Error;
    expect(e.message).toBe('GET /api/task/t1: dueDate "next tuesday" is not a timestamp');
  });
});

// Each field names itself, so a failure says which of a reply's times was unusable.
describe("the other times a reply carries", () => {
  test("a startDate that is not a date names startDate", async () => {
    answers(taskReply({ startDate: "soon" }));
    const e = (await failure(api.getTask("t1"))) as Error;
    expect(e.message).toBe('GET /api/task/t1: startDate "soon" is not a timestamp');
  });

  test("a project's archivedAt that is not a date names archivedAt", async () => {
    answers(JSON.stringify({ id: "p1", name: "x", slug: "x", workspaceId: "w1", archivedAt: "soon" }));
    const e = (await failure(api.getProject("p1"))) as Error;
    expect(e.message).toBe('GET /api/project/p1: archivedAt "soon" is not a timestamp');
  });

  test("a project with no archivedAt is not archived rather than archived at the zero time", async () => {
    answers(JSON.stringify({ id: "p1", name: "x", slug: "x", workspaceId: "w1" }));
    expect((await api.getProject("p1")).archivedAt).toBe(null);
  });

  test("an activity's createdAt that is not a date names createdAt", async () => {
    answers(JSON.stringify([{ id: "a1", taskId: "t1", type: "comment", createdAt: "soon", updatedAt: TIME }]));
    const e = (await failure(api.listActivities("t1"))) as Error;
    expect(e.message).toBe('GET /api/activity/t1: createdAt "soon" is not a timestamp');
  });

  test("a comment's createdAt that is not a date names createdAt", async () => {
    answers(JSON.stringify([{ id: "c1", content: "x", userId: "u1", createdAt: "soon" }]));
    const e = (await failure(api.listComments("t1"))) as Error;
    expect(e.message).toBe('GET /api/comment/t1: createdAt "soon" is not a timestamp');
  });
});

// A write has already happened by the time its reply is read, and the message
// has to name that request, not the read that follows it.
describe("a time that fails to read in the reply to a write", () => {
  test("names the POST that was made", async () => {
    answers(taskReply({ createdAt: "soon" }));
    const e = (await failure(
      api.createTask("p1", {
        title: "x",
        description: "",
        priority: "",
        status: "",
        startDate: "",
        dueDate: "",
        assigneeId: "",
      }),
    )) as Error;
    expect(e.message).toBe('POST /api/task/p1: createdAt "soon" is not a timestamp');
  });

  test("a comment's names the POST that was made", async () => {
    answers(JSON.stringify({ id: "c1", content: "x", userId: "u1", createdAt: "soon" }));
    const e = (await failure(api.addComment("t1", "x"))) as Error;
    expect(e.message).toBe('POST /api/comment/t1: createdAt "soon" is not a timestamp');
  });

  test("is a TimestampError, which a caller can tell from a request that failed", async () => {
    answers(taskReply({ createdAt: "soon" }));
    expect(await failure(api.getTask("t1"))).toBeInstanceOf(api.TimestampError);
  });

  test("is passed on by afterWrite with the write named", async () => {
    answers(JSON.stringify({ id: "c1", content: "x", userId: "u1", createdAt: "soon" }));
    const e = (await failure(api.afterWrite("commented", "look there", api.addComment("t1", "x")))) as Error;
    expect(e).toBeInstanceOf(api.TimestampError);
    expect(e.message).toBe(
      'commented on the server, but its reply could not be read (POST /api/comment/t1: createdAt "soon" is not a timestamp); do not run it again, that would repeat the write; look there',
    );
    expect((e.cause as Error).message).toBe('POST /api/comment/t1: createdAt "soon" is not a timestamp');
  });

  test("is not rewritten by afterWrite when the request itself failed", async () => {
    answers("{}");
    const e = (await failure(api.afterWrite("commented", "look there", Promise.reject(new Error("down"))))) as Error;
    expect(e.message).toBe("down");
  });

  test("on an object no reply produced says so rather than naming no request", () => {
    expect(() => api.isoTime({ createdAt: "soon" }, "createdAt")).toThrow(
      "createdAt is not a timestamp, and no request is recorded for the object that holds it",
    );
  });

  // The write guards test for TimestampError, so a failure to name the request
  // must still be one or a write would go unreported.
  test("on an object no reply produced is still reported as a write by afterWrite", async () => {
    const e = (await failure(
      api.afterWrite("did it", "look there", (async () => api.isoTime({ createdAt: "soon" }, "createdAt"))()),
    )) as Error;
    expect(e).toBeInstanceOf(api.TimestampError);
    expect(e.message).toStartWith("did it on the server, but its reply could not be read (createdAt is not a timestamp");
  });
});

// Every mapper reads its times through the same helper, but each hands it the
// object it was given, so each one is held to naming its request.
describe("every resource that carries a time names its request when the time is unreadable", () => {
  const BAD = "soon";
  test.each([
    ["an invitation", "GET /api/invitation/i1", { invitation: { id: "i1", expiresAt: BAD } }, () => api.getInvitation("i1"), "expiresAt"],
    ["a search result", "GET /api/search", { results: [{ id: "r1", type: "task", createdAt: BAD }] }, () => api.search({ query: "q", workspaceId: "w", projectId: "", type: "", limit: "" }), "createdAt"],
    ["a workflow rule", "GET /api/workflow-rule/p1", [{ id: "r1", createdAt: TIME, updatedAt: BAD }], () => api.listWorkflowRules("p1"), "updatedAt"],
    ["a stored workflow rule", "PUT /api/workflow-rule/p1", { id: "r1", createdAt: BAD }, () => api.setWorkflowRule("p1", { integrationType: "github", eventType: "pr", columnId: "c" }), "createdAt"],
    ["a time entry", "GET /api/time-entry/task/t1", [{ id: "e1", startTime: BAD }], () => api.listTimeEntries("t1"), "startTime"],
    ["a time entry's end", "GET /api/time-entry/task/t1", [{ id: "e1", startTime: TIME, endTime: BAD }], () => api.listTimeEntries("t1"), "endTime"],
    ["a notification", "GET /api/notification", [{ id: "n1", createdAt: BAD }], () => api.listNotifications(), "createdAt"],
    ["a label", "GET /api/label/workspace/w1", [{ id: "l1", createdAt: TIME, updatedAt: TIME, deletionStartedAt: BAD }], () => api.listWorkspaceLabels("w1"), "deletionStartedAt"],
    ["an external link", "GET /api/external-link/task/t1", [{ id: "x1", createdAt: BAD }], () => api.listExternalLinks("t1"), "createdAt"],
  ] as const)("%s", async (_what, request, reply, call, field) => {
    answers(JSON.stringify(reply));
    const e = (await failure(call())) as Error;
    expect(e.message).toBe(`${request}: ${field} "soon" is not a timestamp`);
  });
});
