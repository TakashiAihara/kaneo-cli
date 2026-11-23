import { describe, expect, test } from "bun:test";
import {
  decodeHolds,
  dropHold,
  encodeHolds,
  holdOf,
  mergeHolds,
  pickSessionField,
  upsertHold,
  type SessionHold,
} from "../../src/session/holds";
import { CLOSED, format, RUNNING, type Marker } from "../../src/session/marker";
import type { CustomField } from "../../src/api/kaneo";

const hold = (h: Partial<SessionHold>): SessionHold => ({
  sessionId: "",
  host: "",
  cwd: "",
  branch: "",
  nextStep: "",
  at: "",
  ...h,
});

const marker = (m: Partial<Marker>): Marker => ({
  sessionId: "",
  host: "",
  cwd: "",
  branch: "",
  state: "",
  nextStep: "",
  createdAt: "",
  ...m,
});

const field = (f: Partial<CustomField>): CustomField => ({
  id: "",
  projectId: "proj-1",
  name: "",
  type: "text",
  required: false,
  defaultValue: null,
  options: null,
  position: 0,
  createdAt: "",
  updatedAt: "",
  ...f,
});

describe("holds codec", () => {
  test("a written value reads back as the holds it was", () => {
    const holds = [
      hold({
        sessionId: "s1",
        host: "h1",
        cwd: "/w/one",
        branch: "main",
        nextStep: "ship it",
        at: "2026-01-01T00:00:00Z",
      }),
      hold({ sessionId: "s2", host: "h2", cwd: "/w/two", branch: "", nextStep: "", at: "2026-01-01T01:00:00Z" }),
    ];
    expect(decodeHolds(encodeHolds(holds))).toEqual(holds);
  });

  test("a next step with quotes and unicode survives the round trip", () => {
    const holds = [hold({ sessionId: "s1", nextStep: `say "hi" — 次の一手`, at: "t" })];
    expect(decodeHolds(encodeHolds(holds))).toEqual(holds);
  });

  test("an empty or absent value holds nothing", () => {
    expect(decodeHolds(null)).toEqual([]);
    expect(decodeHolds("")).toEqual([]);
    expect(decodeHolds("   ")).toEqual([]);
  });

  test("a value that is not the JSON holds are written as is refused", () => {
    expect(() => decodeHolds("not json")).toThrow("not JSON");
    expect(() => decodeHolds("{}")).toThrow("not a list of session holds");
    expect(() => decodeHolds(`[{"sessionId":"s1"}]`)).toThrow("not a list of session holds");
  });
});

describe("hold writes", () => {
  test("upsert replaces the hold a session already has and keeps the rest in order", () => {
    const holds = [hold({ sessionId: "s1", nextStep: "first" }), hold({ sessionId: "s2" })];
    const next = upsertHold(holds, hold({ sessionId: "s1", nextStep: "second" }));
    expect(next).toEqual([hold({ sessionId: "s1", nextStep: "second" }), hold({ sessionId: "s2" })]);
    expect(upsertHold(holds, hold({ sessionId: "s3" }))).toEqual([...holds, hold({ sessionId: "s3" })]);
  });

  test("drop removes only the named session", () => {
    const holds = [hold({ sessionId: "s1" }), hold({ sessionId: "s2" })];
    expect(dropHold(holds, "s1")).toEqual([hold({ sessionId: "s2" })]);
    expect(dropHold(holds, "s3")).toEqual(holds);
  });

  test("a hold carries every marker field plus the write's time", () => {
    const m = marker({
      sessionId: "s1",
      host: "h",
      cwd: "/w",
      branch: "b",
      state: RUNNING,
      nextStep: "step",
      createdAt: "ignored",
    });
    expect(holdOf(m, "2026-01-02T03:04:05Z")).toEqual({
      sessionId: "s1",
      host: "h",
      cwd: "/w",
      branch: "b",
      nextStep: "step",
      at: "2026-01-02T03:04:05Z",
    });
  });
});

describe("mergeHolds", () => {
  const comment = (content: string, createdAt: string) => ({ content, createdAt });

  test("a session the field names is held as the field says, marker or not", () => {
    const holds = [
      hold({ sessionId: "s1", host: "field-host", cwd: "/field", nextStep: "from field", at: "2026-01-01T00:00:00Z" }),
    ];
    // A running marker for the same session is older storage for the same
    // hold: the field's entry is the one that counts.
    const comments = [
      comment(format(marker({ sessionId: "s1", host: "marker-host", state: RUNNING })), "2026-01-01T00:00:00Z"),
    ];
    const merged = mergeHolds(holds, comments);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.host).toBe("field-host");
    expect(merged[0]!.nextStep).toBe("from field");
  });

  test("a marker for a session the field does not name still counts", () => {
    const holds = [hold({ sessionId: "s1", at: "2026-01-01T00:00:00Z" })];
    const comments = [
      comment(format(marker({ sessionId: "s2", host: "old-host", state: RUNNING })), "2026-01-01T00:00:00Z"),
    ];
    const merged = mergeHolds(holds, comments);
    expect(merged.map((m) => m.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(merged.find((m) => m.sessionId === "s2")!.host).toBe("old-host");
  });

  test("a closed marker for a field-held session does not close the field's hold", () => {
    const holds = [hold({ sessionId: "s1", at: "2026-01-01T00:00:00Z" })];
    const comments = [comment(format(marker({ sessionId: "s1", state: CLOSED })), "2026-01-01T02:00:00Z")];
    expect(mergeHolds(holds, comments).map((m) => m.sessionId)).toEqual(["s1"]);
  });

  test("a session named twice in the value is held as its later entry", () => {
    const holds = [
      hold({ sessionId: "s1", nextStep: "older", at: "2026-01-01T00:00:00Z" }),
      hold({ sessionId: "s1", nextStep: "newer", at: "2026-01-01T01:00:00Z" }),
    ];
    const merged = mergeHolds(holds, []);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.nextStep).toBe("newer");
  });

  test("holds and markers merge into one list, oldest hold first", () => {
    const holds = [hold({ sessionId: "s-field", at: "2026-01-01T01:00:00Z" })];
    const comments = [
      comment(format(marker({ sessionId: "s-marker", state: RUNNING })), "2026-01-01T02:00:00Z"),
      comment("no marker", "2026-01-01T03:00:00Z"),
    ];
    expect(mergeHolds(holds, comments).map((m) => m.sessionId)).toEqual(["s-field", "s-marker"]);
  });
});

describe("pickSessionField", () => {
  test("a project with no session field picks none", () => {
    expect(pickSessionField([field({ name: "other" })], "proj-1")).toBeUndefined();
    expect(pickSessionField([], "proj-1")).toBeUndefined();
  });

  test("the one text field named for sessions is picked", () => {
    const wanted = field({ id: "f1", name: "kaneo-session" });
    expect(pickSessionField([field({ name: "other" }), wanted], "proj-1")).toBe(wanted);
  });

  test("two fields sharing the name are refused rather than guessed", () => {
    const fields = [field({ id: "f1", name: "kaneo-session" }), field({ id: "f2", name: "kaneo-session" })];
    expect(() => pickSessionField(fields, "proj-1")).toThrow("kaneo-session");
  });

  test("a field of another type is refused rather than overwritten", () => {
    const fields = [field({ id: "f1", name: "kaneo-session", type: "number" })];
    expect(() => pickSessionField(fields, "proj-1")).toThrow("not text");
  });
});
