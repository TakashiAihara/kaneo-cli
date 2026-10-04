import { describe, expect, test } from "bun:test";
import { sameResult, type ScenarioResult } from "../parity/run";

// What parity:record uses to decide which goldens to leave alone. A comparison
// looser than the suite's would leave a golden the suite rejects; a stricter one
// would churn goldens for nothing.

const base = (): ScenarioResult => ({
  steps: [{ args: ["task", "ls"], exit: 0, stdout: "out\n", stderr: "" }],
  requests: [{ method: "PUT", path: "/x", query: "", body: { a: 1, b: { c: 2 } } }],
  files: { "a.json": "{}" },
});

describe("sameResult", () => {
  test("TestSameResultIgnoresTheKeyOrderOfARequestBody", () => {
    const got = base();
    got.requests[0]!.body = { b: { c: 2 }, a: 1 };
    expect(sameResult(base(), got)).toBe(true);
  });

  test.each([
    ["stdout", (r: ScenarioResult) => (r.steps[0]!.stdout += "x")],
    ["stderr", (r: ScenarioResult) => (r.steps[0]!.stderr = "e")],
    ["exit", (r: ScenarioResult) => (r.steps[0]!.exit = 1)],
    ["args", (r: ScenarioResult) => r.steps[0]!.args.push("--json")],
    ["a step more", (r: ScenarioResult) => r.steps.push({ args: [], exit: 0, stdout: "", stderr: "" })],
    ["a request method", (r: ScenarioResult) => (r.requests[0]!.method = "POST")],
    ["a request path", (r: ScenarioResult) => (r.requests[0]!.path = "/y")],
    ["a request query", (r: ScenarioResult) => (r.requests[0]!.query = "a=1")],
    ["a request body value", (r: ScenarioResult) => ((r.requests[0]!.body as { a: number }).a = 2)],
    ["a request more", (r: ScenarioResult) => r.requests.push({ method: "GET", path: "/y", query: "", body: undefined })],
    ["a file's content", (r: ScenarioResult) => (r.files["a.json"] = "[]")],
    ["a file more", (r: ScenarioResult) => (r.files["b.json"] = "")],
  ])("TestSameResultSeesADifferent %s", (_name, change) => {
    const got = base();
    change(got);
    expect(sameResult(base(), got)).toBe(false);
  });
});
