import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOSED, format, latestPerSession, parse, RUNNING, running, type Marker } from "../../src/session/marker";

// Ported from the Go build's internal/session/marker_test.go and compat_test.go.

const mk = (m: Partial<Marker>): Marker => ({
  sessionId: "",
  host: "",
  cwd: "",
  branch: "",
  state: "",
  nextStep: "",
  createdAt: "",
  ...m,
});

// The exact bytes the Python `kn` writes. Both implementations read the same
// board while one replaces the other, so this must keep parsing.
const pythonMarker =
  "<!-- kn:session id=abc-123 host=d1 cwd=/root/.ccx/x/01ABC branch=main state=running -->\n" + "次の一手: CI を待つ";

describe("marker", () => {
  test("TestParsesTheMarkerWrittenByPython", () => {
    const m = parse(pythonMarker, "2026-08-26T00:00:00Z");
    expect(m).toBeDefined();
    expect(m!.sessionId).toBe("abc-123");
    expect(m!.host).toBe("d1");
    expect(m!.cwd).toBe("/root/.ccx/x/01ABC");
    expect(m!.branch).toBe("main");
    expect(m!.state).toBe(RUNNING);
    expect(m!.nextStep).toBe("CI を待つ");
  });

  test("TestFormatIsReadableByThePythonParser", () => {
    const got = format(mk({ sessionId: "abc-123", host: "d1", cwd: "/root/repo", branch: "main", state: RUNNING, nextStep: "CI を待つ" }));
    expect(got).toBe("<!-- kn:session id=abc-123 host=d1 cwd=/root/repo branch=main state=running enc=1 -->\nCI を待つ");
  });

  test("TestRoundTrip", () => {
    const input = mk({ sessionId: "s1", host: "pi", cwd: "/home/x/repo", branch: "feat/thing", state: CLOSED, nextStep: "done" });
    const out = parse(format(input), "t0");
    expect(out).toBeDefined();
    expect({ ...out!, createdAt: "" }).toEqual(input);
  });

  test("TestEmptyFieldsRoundTripAsAbsent", () => {
    const out = parse(format(mk({ sessionId: "s1", state: RUNNING })), "t0");
    expect(out).toBeDefined();
    expect([out!.host, out!.cwd, out!.branch]).toEqual(["", "", ""]);
  });

  test("TestPlainCommentIsNotAMarker", () => {
    expect(parse("just a human comment mentioning kn:session in passing", "t0")).toBeUndefined();
    expect(parse("", "t0")).toBeUndefined();
  });

  test("TestMarkerWithoutNextStep", () => {
    const m = parse("<!-- kn:session id=s1 host=d1 cwd=/x branch=main state=closed -->", "t0");
    expect(m).toBeDefined();
    expect(m!.nextStep).toBe("");
  });

  // attach, next and close each append a comment, so a session leaves a trail.
  // Only the newest entry describes the session's actual state.
  test("TestLatestPerSessionCollapsesTheTrail", () => {
    const markers = [
      mk({ sessionId: "s1", state: RUNNING, createdAt: "2026-08-26T01:00:00Z", nextStep: "start" }),
      mk({ sessionId: "s2", state: RUNNING, createdAt: "2026-08-26T02:00:00Z" }),
      mk({ sessionId: "s1", state: RUNNING, createdAt: "2026-08-26T03:00:00Z", nextStep: "middle" }),
      mk({ sessionId: "s1", state: CLOSED, createdAt: "2026-08-26T04:00:00Z" }),
    ];
    const latest = latestPerSession(markers);
    expect(latest).toHaveLength(2);
    expect(latest.find((m) => m.sessionId === "s1")!.state).toBe(CLOSED);
    const live = running(latest);
    expect(live.map((m) => m.sessionId)).toEqual(["s2"]);
  });

  test("TestFormatKeepsTheMarkerOnOneLine", () => {
    const out = parse(format(mk({ sessionId: "s1", cwd: "/tmp/a\nb", branch: "main", state: RUNNING })), "t0");
    expect(out).toBeDefined();
    expect(out!.branch).toBe("main");
  });

  // A value containing a space followed by something shaped like a key would
  // otherwise end the field early.
  test("TestValueContainingAFieldSeparatorSurvives", () => {
    for (const cwd of ["/work/client foo=bar", "/work/my client", "/work/100% sure", "/work/a\tb", "/work/trailing branch=notreal"]) {
      const input = mk({ sessionId: "s1", host: "h", cwd, branch: "main", state: RUNNING });
      const out = parse(format(input), "t0");
      expect(out, `cwd ${cwd} did not parse`).toBeDefined();
      expect(out!.cwd).toBe(cwd);
      expect(out!.branch).toBe("main");
    }
  });

  // The Python implementation splits the marker body on whitespace.
  test("TestEncodedValueHasNoWhitespace", () => {
    let body = format(mk({ sessionId: "s1", cwd: "/work/my client", branch: "main", state: RUNNING }));
    body = body.slice(body.indexOf("kn:session ") + "kn:session ".length, body.indexOf("-->"));
    for (const field of body.split(/\s+/).filter((f) => f !== "")) {
      expect(field, `a value was split across tokens: ${body}`).toContain("=");
    }
  });

  test("TestRawValuesFromTheOtherImplementationAreUnchanged", () => {
    const m = parse("<!-- kn:session id=abc host=d1 cwd=/root/x branch=main state=running -->", "t0");
    expect(m).toBeDefined();
    expect(m!.cwd).toBe("/root/x");
  });

  // A marker written by the older implementation stores values raw.
  test("TestLegacyMarkerValuesAreNotDecoded", () => {
    const m = parse("<!-- kn:session id=s1 host=d1 cwd=/repo/100%20done branch=feature%2Fx state=running -->", "t0");
    expect(m).toBeDefined();
    expect(m!.cwd).toBe("/repo/100%20done");
    expect(m!.branch).toBe("feature%2Fx");
  });

  test("TestDeclaredEncodedMarkerIsDecoded", () => {
    const m = parse("<!-- kn:session id=s1 host=d1 cwd=/repo/100%20done branch=main state=running enc=1 -->", "t0");
    expect(m).toBeDefined();
    expect(m!.cwd).toBe("/repo/100 done");
  });

  test("TestValueContainingCommentTerminatorRoundTrips", () => {
    for (const cwd of ["/work/a-->b", "/work/a>b", "/work/<x>"]) {
      const formatted = format(mk({ sessionId: "s1", cwd, branch: "main", state: RUNNING }));
      expect(formatted.split("-->").length - 1, `stray terminator: ${formatted}`).toBe(1);
      const out = parse(formatted, "t0");
      expect(out, formatted).toBeDefined();
      expect(out!.cwd).toBe(cwd);
    }
  });

  // testdata/real_markers.json holds comments captured from a live board that
  // the Python implementation wrote, with ids, hosts and paths replaced by
  // placeholders; layout and non-ASCII content are as captured.
  test("TestParsesMarkersCapturedFromALiveBoard", () => {
    const comments = JSON.parse(readFileSync(join(import.meta.dir, "testdata", "real_markers.json"), "utf8")) as {
      content: string;
      createdAt: string;
    }[];
    expect(comments.length, "no captured markers; the fixture would pin nothing").toBeGreaterThan(0);

    const markers: Marker[] = [];
    for (const c of comments) {
      const m = parse(c.content, c.createdAt);
      expect(m, `not recognised:\n${c.content}`).toBeDefined();
      expect(m!.sessionId, c.content).not.toBe("");
      expect([RUNNING, CLOSED], c.content).toContain(m!.state as never);
      expect(m!.host, c.content).not.toBe("");
      expect(m!.cwd, c.content).not.toBe("");
      markers.push(m!);
    }
    for (const m of markers) expect(m.nextStep.startsWith("次の一手"), `next step kept its label: ${m.nextStep}`).toBe(false);
    const got = latestPerSession(markers);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(markers.length);
  });
});
