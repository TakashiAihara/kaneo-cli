import { expect, test } from "bun:test";
import { nextTag } from "../scripts/next-tag";

test.each([
  [["v0.2.0", "v0.1.0"], "v0.2.1-rc.1"],
  [["v0.2.0", "v0.2.1-rc.1", "v0.2.1-rc.2"], "v0.2.1-rc.3"],
  // The final version sorts above its own candidates, not below.
  [["v0.3.0-rc.9", "v0.3.0", "v0.3.0-rc.10"], "v0.3.1-rc.1"],
  // Numeric, not lexical: rc.10 is above rc.9 and minor 10 above minor 9.
  [["v0.9.0", "v0.10.0-rc.9", "v0.10.0-rc.10"], "v0.10.0-rc.11"],
  [["v1.0.0", "latest", "v2", ""], "v1.0.1-rc.1"],
])("nextTag(%p) is %p", (tags, want) => {
  expect(nextTag(tags)).toBe(want);
});

test("no version tag is an error, not a tag", () => {
  expect(() => nextTag(["latest", ""])).toThrow();
});
