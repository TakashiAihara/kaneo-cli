import { describe, expect, test } from "bun:test";
import type { Task } from "../../src/api/kaneo";
import { sameReference, sharedReference, SIMILAR_TITLE, similarOpenTasks, titleSimilarity } from "../../src/cli/similar";

// What `task create` reads the board for: work a title already names. A shared
// reference refuses the create and alike wording only warns, so these pin the
// two answers rather than one threshold. The scores below are written out rather
// than compared against SIMILAR_TITLE, so a change to it cannot make a test pass
// by moving the bar under itself.

describe("titleSimilarity", () => {
  // A title in Japanese differs by one word as often as an English one, and
  // bigrams cut it into characters rather than half of one, so the words that
  // stayed are still what is compared.
  test("TestJapaneseTitlesDifferingByOneWordAreSimilar", () => {
    expect(titleSimilarity("パースラーを直す", "パースラーを直すテスト")).toBeCloseTo(0.82, 2);
  });

  test("TestUnrelatedTitlesAreNotSimilar", () => {
    expect(titleSimilarity("Write the parser", "Ship it")).toBeCloseTo(0.11, 2);
    expect(titleSimilarity("パースラーを直す", "CI を直す")).toBeLessThan(0.6);
    expect(titleSimilarity("Fix the login page", "Update the release notes")).toBeLessThan(0.6);
  });

  // A pair just under the threshold, so a warning applied at any lower value than
  // 0.6 names it and the assertion through similarOpenTasks fails.
  test("TestAPairJustUnderTheThresholdIsBelowIt", () => {
    expect(titleSimilarity("Write docs for the CLI", "Write code for the API")).toBeGreaterThan(0.5);
    expect(titleSimilarity("Write docs for the CLI", "Write code for the API")).toBeLessThan(0.6);
    expect(SIMILAR_TITLE).toBe(0.6);
    expect(similarOpenTasks("Write docs for the CLI", [task(1, "Write code for the API", "to-do")])).toEqual([]);
  });

  // Whitespace and case are how the same title is typed twice.
  test("TestCaseAndWhitespaceDoNotMakeATitleADifferentOne", () => {
    expect(titleSimilarity("Write The Parser", "write theparser")).toBe(1);
    expect(titleSimilarity("a b c d", "abcd")).toBe(1);
  });

  // A title of one character is as alike another as a long one is itself: the
  // comparison is of the text, not of how many bigrams it has.
  test("TestOneCharacterTitlesAreComparedWhole", () => {
    expect(titleSimilarity("x", "x")).toBe(1);
    expect(titleSimilarity("x", "y")).toBe(0);
  });

  // Two tasks worded differently that are about the same issue are the case the
  // references are for: no two of these words are alike enough on their own.
  test("TestASharedReferenceIsSimilarWhateverTheWordsAre", () => {
    expect(titleSimilarity("Fix owner/repo#165 crash", "Follow up on owner/repo#165")).toBe(1);
  });

  // The numbers are compared as written and the case of a name is ignored, since
  // a slug is written in whatever case its author had.
  test("TestReferencesAreMatchedAsWritten", () => {
    expect(sameReference("fix ALP#3", "fix ALP#3")).toBe(true);
    expect(sameReference("fix ALP#3", "fix alp#3")).toBe(true);
    expect(sameReference("fix ALP#3", "fix #3")).toBe(false);
    expect(sameReference("fix ALP#12", "fix ALP#123")).toBe(false);
    expect(sameReference("fix ccx#165", "fix kaneo-cli#165")).toBe(false);
    expect(sameReference("no reference here", "none either")).toBe(false);
  });

  // A numbered phrase counts a phase, a step or a pull request as often as it
  // counts an issue, and those are most of the titles that write one: of the 889
  // titles measured, 16 write `name #N` away from a parenthesis and they are a
  // mixture of repositories with plain words. Only a name written onto the number
  // names an issue, and a bare `#N` never does.
  test("TestANameWrittenOffTheNumberIsNotAReference", () => {
    expect(sameReference("Fix #7", "Fix #7 again")).toBe(false);
    expect(sameReference("Phase #1 design", "Phase #1 implement")).toBe(false);
    expect(sameReference("PR #12 review", "PR #12 merge")).toBe(false);
    expect(sameReference("ccx #165", "ccx #165")).toBe(false);
    expect(sameReference("#3", "#3")).toBe(false);
    expect(sameReference("fix #12", "fix #12 again")).toBe(false);
  });

  // The one place the space is written: a reference in brackets, where the name
  // comes right after the opening parenthesis.
  test("TestABracketedReferenceIsAReferenceWithItsSpace", () => {
    expect(sameReference("(ccx #165)", "ccx#165 を直す")).toBe(true);
    expect(sameReference("（ccx #165 の後続）", "Fix ccx#165")).toBe(true);
  });

  // A word character after the number says the number runs on into something
  // else. Nothing else after it is part of it, so a colon labels a phrase of the
  // title and the reference is still the one both titles name.
  test("TestTheNumberHasToEndTheReference", () => {
    expect(sameReference("ccx#165a", "ccx#165")).toBe(false);
    expect(sameReference("ccx#165: crash", "ccx#165 crash")).toBe(true);
  });

  // The repository is what names an issue, so a title that writes the owner and
  // one that does not name the same issue; two owners written out and differing
  // are two issues, since only one of them is where it was filed.
  test("TestAnOwnerIsLeftOutUnlessBothTitlesWriteOne", () => {
    expect(sameReference("fix TakashiAihara/ccx#165", "fix ccx#165")).toBe(true);
    expect(sameReference("fix ccx#165", "fix TakashiAihara/ccx#165")).toBe(true);
    expect(sameReference("alice/repo#7", "alice/repo#7")).toBe(true);
    expect(sameReference("alice/repo#7", "bob/repo#7")).toBe(false);
  });

  test("TestATitleWithNothingInItIsLikeNothing", () => {
    expect(titleSimilarity("", "Write the parser")).toBe(0);
    expect(titleSimilarity("Write the parser", "   ")).toBe(0);
    expect(titleSimilarity("", "")).toBe(0);
  });
});

const task = (number: number, title: string, status: string): Task => ({
  id: `task-${number}`,
  number,
  title,
  description: "",
  status,
  priority: "no-priority",
  position: number,
  projectId: "proj",
  assigneeId: null,
  assigneeName: null,
  startDate: null,
  dueDate: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  labels: null,
});

describe("sharedReference", () => {
  // This is what refuses the create, so it is the pair the refusal is worth,
  // whether the number is written onto the name or inside a bracket.
  test("TestTheOpenTasksNamingTheReferenceAreFound", () => {
    const open = [task(7, "Fix ccx#165 crash", "to-do"), task(8, "Ship it", "in-progress")];
    const shared = sharedReference("Follow up on ccx#165", open);
    expect(shared?.reference).toBe("ccx#165");
    expect(shared?.tasks.map((t) => t.number)).toEqual([7]);
    expect(sharedReference("Follow up on (ccx #165)", open)?.tasks.map((t) => t.number)).toEqual([7]);
  });

  // The message names the reference as the title being created wrote it: an
  // owner it left out is not one the message should invent, and one it wrote is
  // what the reader has to search the board for.
  test("TestTheReferenceIsNamedAsTheNewTitleWroteIt", () => {
    const board = [task(7, "Fix ccx#165", "to-do")];
    expect(sharedReference("Follow up TakashiAihara/ccx#165", board)?.reference).toBe("takashiaihara/ccx#165");
    expect(sharedReference("Follow up ccx#165", [task(7, "Fix TakashiAihara/ccx#165", "to-do")])?.reference).toBe("ccx#165");
  });

  // The refusal path rather than the warning one: finished and filed-away work
  // is the next round of it, so creating beside it is not a duplicate, while
  // planned work is open backlog a new task joins rather than repeats.
  test("TestFinishedWorkIsNotADuplicateAndPlannedIs", () => {
    for (const status of ["done", "archived"]) {
      expect(sharedReference("Follow up ccx#165", [task(7, "Fix ccx#165", status)])).toBeUndefined();
    }
    expect(sharedReference("Follow up ccx#165", [task(7, "Fix ccx#165", "planned")])?.tasks.map((t) => t.number)).toEqual([7]);
    expect(sharedReference("Follow up ccx#165", [task(7, "Fix ccx#165", "to-do")])?.tasks.map((t) => t.number)).toEqual([7]);
  });

  // Lowest number first whatever order the board answered in, so the same board
  // refuses with the same message every time.
  test("TestTasksSharingTheReferenceAreNamedLowestNumberFirst", () => {
    const open = [task(9, "Again ccx#165", "to-do"), task(7, "Fix ccx#165", "to-do"), task(8, "More ccx#165", "to-do")];
    expect(sharedReference("Follow up ccx#165", open)?.tasks.map((t) => t.number)).toEqual([7, 8, 9]);
  });

  // The two ways a reference is written are found separately, and the one the
  // title writes first still decides, whichever way it was written.
  test("TestTheFirstWrittenReferenceDecidesAcrossBothForms", () => {
    const open = [task(7, "Fix alp#3", "to-do"), task(8, "Fix ccx#165", "to-do")];
    expect(sharedReference("(ccx #165) then alp#3", open)?.reference).toBe("ccx#165");
  });

  // A title naming two open issues is refused on the one it leads with, so the
  // message names one issue rather than a set of them.
  test("TestTheFirstSharedReferenceDecides", () => {
    const open = [task(7, "Fix alp#3", "to-do"), task(8, "Fix ccx#165", "to-do")];
    const shared = sharedReference("ccx#165 then alp#3", open);
    expect(shared?.reference).toBe("ccx#165");
    expect(shared?.tasks.map((t) => t.number)).toEqual([8]);
  });

  test("TestNothingIsSharedWithoutAReference", () => {
    expect(sharedReference("Write the parser", [task(1, "Write the parser", "to-do")])).toBeUndefined();
    expect(sharedReference("Write the parser", [task(1, "Write ALP#3", "to-do")])).toBeUndefined();
  });

  // Six open tasks naming the reference is a board's worth of it; the message
  // names five, or it stops being one line.
  test("TestTheMessageNamesAtMostFive", () => {
    const open = Array.from({ length: 6 }, (_, i) => task(i + 1, `Fix ccx#165 (${i})`, "to-do"));
    expect(sharedReference("Fix ccx#165 too", open)?.tasks.map((t) => t.number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("similarOpenTasks", () => {
  // Finished and filed-away work is not a duplicate: a title that repeats it is
  // the next round of it, which is what creating it again is for. Planned work is
  // open backlog, so it is warned about.
  test("TestTasksHoldingFinishedWorkAreNotDuplicates", () => {
    for (const status of ["done", "archived"]) {
      expect(similarOpenTasks("Write the parser", [task(1, "Write the parser", status)])).toEqual([]);
    }
    expect(similarOpenTasks("Write the parser", [task(1, "Write the parser", "planned")]).map((t) => t.number)).toEqual([1]);
    expect(similarOpenTasks("Write the parser", [task(1, "Write the parser", "to-do")]).map((t) => t.number)).toEqual([1]);
  });

  test("TestTheMostSimilarComesFirst", () => {
    const found = similarOpenTasks("Write the parser", [
      task(1, "Write the parser again", "to-do"),
      task(2, "Write the parser", "in-progress"),
      task(3, "Ship it", "to-do"),
    ]);
    expect(found.map((t) => t.number)).toEqual([2, 1]);
  });

  // A number breaks a tie, so the same board names the same tasks in the same
  // order however the listing happened to answer them.
  test("TestAnEqualScoreIsOrderedByNumber", () => {
    const tasks = [task(9, "Write the parser again", "to-do"), task(4, "Write the parser again", "to-do")];
    expect(similarOpenTasks("Write the parser", tasks).map((t) => t.number)).toEqual([4, 9]);
    expect(similarOpenTasks("Write the parser", [...tasks].reverse()).map((t) => t.number)).toEqual([4, 9]);
  });

  test("TestTheMessageNamesAtMostFive", () => {
    const tasks = Array.from({ length: 6 }, (_, i) => task(i + 1, `Write the parser ${i}`, "to-do"));
    expect(similarOpenTasks("Write the parser", tasks).map((t) => t.number)).toEqual([1, 2, 3, 4, 5]);
  });
});