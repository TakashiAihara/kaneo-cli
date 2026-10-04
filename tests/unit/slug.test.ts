import { describe, expect, test } from "bun:test";
import { deriveSlug } from "../../src/cli/project";

// The key a project name derives for its create. The Go build sent whatever
// --slug held, so these have no Go counterpart. The cases are adapted from the
// Kaneo web app's (apps/web/src/lib/generate-project-id.test.ts), since the rule
// is meant to give the key a project made in the web app would get.

describe("deriveSlug", () => {
  test("takes the first three letters of a single word", () => {
    expect(deriveSlug("Kaneo")).toBe("KAN");
  });

  test("takes the initials of the first three words", () => {
    expect(deriveSlug("Alpha Beta Gamma")).toBe("ABG");
    expect(deriveSlug("Alpha Beta Gamma Delta")).toBe("ABG");
  });

  test("ignores a leading separator instead of spending an initial on it", () => {
    expect(deriveSlug(" Kaneo")).toBe("KAN");
    expect(deriveSlug("- Alpha Beta Gamma")).toBe("ABG");
  });

  test("keeps non-Latin scripts", () => {
    expect(deriveSlug("Проект Альфа")).toBe("ПА");
    expect(deriveSlug("測試項目")).toBe("測試項");
    expect(deriveSlug("日本語だけ")).toBe("日本語");
  });

  test("keeps digits and drops punctuation", () => {
    expect(deriveSlug("Sprint 2")).toBe("S2");
    expect(deriveSlug("123abc")).toBe("123");
    expect(deriveSlug("[Alpha] Beta Gamma")).toBe("ABG");
  });

  test("folds full-width characters", () => {
    expect(deriveSlug("ＡＢＣ")).toBe("ABC");
  });

  test("counts code points, not UTF-16 units", () => {
    expect(deriveSlug("𠀀𠀁𠀂𠀃")).toBe("𠀀𠀁𠀂");
    expect(deriveSlug("𐌰lpha 𐌱eta")).toBe("𐌰𐌱");
  });

  test("skips a leading combining mark", () => {
    expect(deriveSlug("\u0301alpha \u0301beta")).toBe("AB");
    expect(deriveSlug("\u0301alpha")).toBe("ALP");
  });

  test("derives nothing from a name with no letter or number", () => {
    expect(deriveSlug("!!!")).toBe("");
    expect(deriveSlug("   ")).toBe("");
  });
});
