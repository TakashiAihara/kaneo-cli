import { describe, expect, test } from "bun:test";
import { unknownCommand, type Command } from "../../src/cli/args";

const run = () => {};
const task: Command<unknown> = {
  name: "task",
  short: "tasks",
  children: [
    { name: "rm", short: "remove", run },
    { name: "get", short: "get", run },
    { name: "list", short: "list", run },
  ],
};

describe("unknownCommand", () => {
  test("TestBareTaskNumberIsNotMatchedToAShortCommandName", () => {
    expect(unknownCommand(task, "kaneo task", "7").message).toBe('unknown command "7" for "kaneo task"');
  });

  test("TestMultiDigitNumberGetsNoSuggestion", () => {
    expect(unknownCommand(task, "kaneo task", "123").message).toBe('unknown command "123" for "kaneo task"');
  });

  test("TestMistypedWordStillGetsASuggestion", () => {
    expect(unknownCommand(task, "kaneo task", "gte").message).toContain("Did you mean this?\n\tget\n");
  });

  test("TestWordWithDigitsStillGetsASuggestion", () => {
    expect(unknownCommand(task, "kaneo task", "r1").message).toContain("\trm\n");
    expect(unknownCommand(task, "kaneo task", "2m").message).toContain("\trm\n");
  });
});
