import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { slug } from "../../scripts/record-golden";
import { runScenario, type ScenarioResult } from "./run";
import { SCENARIOS } from "./scenarios";

// This build against what the Go build did (tests/parity/golden/, recorded by
// scripts/record-golden.ts). Compared field by field so a failure names the
// step and the stream that differ, rather than one opaque diff of everything.
// KANEO_PARITY_BIN points the suite at another build; run it with the Go
// reference to show the goldens are deterministic before trusting a failure.
const CLI = process.env.KANEO_PARITY_BIN
  ? [process.env.KANEO_PARITY_BIN]
  : ["bun", new URL("../../src/index.ts", import.meta.url).pathname];

describe("parity with the Go build", () => {
  for (const s of SCENARIOS) {
    test(s.name, async () => {
      const want: ScenarioResult = JSON.parse(readFileSync(new URL(`golden/${slug(s.name)}.json`, import.meta.url), "utf8"));
      const got = await runScenario(CLI, s);

      for (const [i, w] of want.steps.entries()) {
        const g = got.steps[i]!;
        const at = `step ${i + 1}: kaneo ${w.args.join(" ")}`;
        expect({ at, exit: g.exit }).toEqual({ at, exit: w.exit });
        expect({ at, stdout: g.stdout }).toEqual({ at, stdout: w.stdout });
        expect({ at, stderr: g.stderr }).toEqual({ at, stderr: w.stderr });
      }
      expect(got.requests).toEqual(want.requests);
      expect(got.files).toEqual(want.files);
    }, 30_000);
  }
});
