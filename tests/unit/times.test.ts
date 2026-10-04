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
  ])("that is %p (%s) fails the read, naming the field", async (createdAt) => {
    answers(taskReply({ createdAt }));
    const e = (await failure(api.getTask("t1"))) as Error;
    expect(e.message).toBe(`createdAt ${JSON.stringify(createdAt)} is not a timestamp`);
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
  ])("that is %s reads as %p", async (_what, dueDate, want) => {
    answers(taskReply({ dueDate }));
    expect((await api.getTask("t1")).dueDate).toBe(want);
  });

  test("that is not a date fails the read too", async () => {
    answers(taskReply({ dueDate: "next tuesday" }));
    const e = (await failure(api.getTask("t1"))) as Error;
    expect(e.message).toBe('dueDate "next tuesday" is not a timestamp');
  });
});
