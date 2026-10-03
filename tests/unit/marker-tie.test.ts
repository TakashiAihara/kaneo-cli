import { expect, test } from "bun:test";
import { latestPerSession, RUNNING, CLOSED, type Marker } from "../../src/session/marker";

// No Go test covered the `>=` in LatestPerSession (marker_test.go has only the
// collapse test), so these have no Go counterpart: the rule is ported from
// marker.go itself.

const mk = (m: Partial<Marker>): Marker => ({
  sessionId: "", host: "", cwd: "", branch: "", state: "", nextStep: "", createdAt: "", ...m,
});

test("TestLatestPerSessionTieLaterCommentWins", () => {
  const at = "2026-08-26T01:00:00Z";
  const got = latestPerSession([
    mk({ sessionId: "s1", state: RUNNING, createdAt: at }),
    mk({ sessionId: "s1", state: CLOSED, createdAt: at }),
  ]);
  expect(got).toHaveLength(1);
  expect(got[0]!.state).toBe(CLOSED);
});

test("TestLatestPerSessionOrdersByTimeThenSessionID", () => {
  const got = latestPerSession([
    mk({ sessionId: "b", createdAt: "2026-08-26T01:00:00Z" }),
    mk({ sessionId: "a", createdAt: "2026-08-26T01:00:00Z" }),
    mk({ sessionId: "c", createdAt: "2026-08-26T00:00:00Z" }),
  ]);
  expect(got.map((m) => m.sessionId)).toEqual(["c", "a", "b"]);
});
