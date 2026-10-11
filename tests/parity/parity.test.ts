import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { slug } from "../../scripts/record-golden";
import { runScenario, THIS_BUILD, type ScenarioResult } from "./run";
import { SCENARIOS } from "./scenarios";

// This build against tests/parity/golden/: recorded from the Go build when it
// was retired, and from this tree for scenarios added and changes intended since
// (scripts/record-golden.ts). Compared field by field so a failure names the
// step and the stream that differ, rather than one opaque diff of everything.
// KANEO_PARITY_BIN points the suite at another build, such as the last release,
// to see which goldens an unreleased change moved.
const CLI = process.env.KANEO_PARITY_BIN ? [process.env.KANEO_PARITY_BIN] : THIS_BUILD;

// A golden whose scenario was renamed or removed is never compared, so it would
// sit in the tree looking like coverage.
test("every golden has a scenario", () => {
  const recorded = new Set(SCENARIOS.map((s) => `${slug(s.name)}.json`));
  const orphans = readdirSync(new URL("golden/", import.meta.url)).filter((name) => !recorded.has(name));
  expect(orphans).toEqual([]);
});

const parsesAsOne = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

describe("parity with the recorded goldens", () => {
  for (const s of SCENARIOS) {
    test(s.name, async () => {
      const want: ScenarioResult = JSON.parse(readFileSync(new URL(`golden/${slug(s.name)}.json`, import.meta.url), "utf8"));
      const got = await runScenario(CLI, s);

      // The golden's own shape first: a scenario edited after recording would
      // otherwise compare only the steps both sides happen to share.
      expect(got.steps.map((s) => s.args)).toEqual(want.steps.map((s) => s.args));
      for (const [i, w] of want.steps.entries()) {
        const g = got.steps[i]!;
        const at = `step ${i + 1}: kaneo ${w.args.join(" ")}`;
        expect({ at, exit: g.exit }).toEqual({ at, exit: w.exit });
        expect({ at, stdout: g.stdout }).toEqual({ at, stdout: w.stdout });
        expect({ at, stderr: g.stderr }).toEqual({ at, stderr: w.stderr });
        // JSON mode (--json, or the pipe these runs write to) promises one
        // document on stdout, failure or not, so a second one appended after the
        // payload is caught whichever command adds it. Help, completion and
        // --version print text, and start with neither bracket.
        if (!w.args.includes("--human") && !w.args.includes("--jq") && /^[[{]/.test(g.stdout)) {
          expect({ at, parses: parsesAsOne(g.stdout) }).toEqual({ at, parses: true });
        }
      }
      expect(got.requests).toEqual(want.requests);
      expect(got.files).toEqual(want.files);
    }, 30_000);
  }
});
