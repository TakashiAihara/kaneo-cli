import { describe, expect, test } from "bun:test";
import { lastFlagValue } from "../../src/cli/args";
import type { Flag } from "../../src/cli/args";

const flags: Flag[] = [
  { name: "jq", type: "string", usage: "", defaultValue: "" },
  { name: "description", shorthand: "d", type: "string", usage: "", defaultValue: "" },
  { name: "timeout", type: "duration", usage: "", defaultValue: "0s" },
  { name: "query", shorthand: "q", type: "string", usage: "", defaultValue: "" },
  { name: "json", shorthand: "j", type: "bool", usage: "", defaultValue: "false" },
];

describe("lastFlagValue", () => {
  test.each([
    ["not given", ["task", "get", "1"], undefined],
    ["spaced", ["--jq", ".number"], ".number"],
    ["with an equals sign", ["--jq=.number"], ".number"],
    ["empty after an equals sign", ["--jq="], ""],
    ["empty as the next word", ["--jq", ""], ""],
    ["no word left", ["--jq"], ""],
    ["last one wins over an empty one", ["--jq", "", "--jq", ".number"], ".number"],
    ["last one wins when it is empty", ["--jq", ".x", "--jq", ""], ""],
    ["last one wins across spellings", ["--jq=.a", "--jq", ".b"], ".b"],
    ["value of a string flag is not a flag", ["--description", "--jq"], undefined],
    ["value of a string flag is not a terminator", ["--description", "--", "--jq", ".x"], ".x"],
    ["value of a duration flag is not a flag", ["--timeout", "--jq", "--jq", ".x"], ".x"],
    ["an equals sign takes no further word", ["--description=a", "--jq", ".x"], ".x"],
    ["terminator ends the search", ["--", "--jq", ".x"], undefined],
    ["terminator keeps what came before", ["--jq", ".x", "--", "--jq", ""], ".x"],
    ["bool flag takes no word", ["--json", "--jq", ".x"], ".x"],
    ["unknown flag is stepped over", ["--bogus", "--jq=.x"], ".x"],
    ["shorthand value is skipped", ["-d", "--jq", "--jq", ".x"], ".x"],
    ["shorthand with the value attached", ["-dvalue", "--jq", ".x"], ".x"],
    ["shorthand with an equals sign", ["-d=--jq", "--jq", ".x"], ".x"],
    ["bool shorthands cluster before a value", ["-jd", "--jq", "--jq", ".x"], ".x"],
    ["unknown shorthand is stepped over", ["-z", "--jq", ".x"], ".x"],
    ["bare dash is a word", ["-", "--jq", ".x"], ".x"],
    ["empty word is a word", ["", "--jq", ".x"], ".x"],
    ["a word is not a cluster of shorthands", ["xd", "--jq", ".x"], ".x"],
  ] as [string, string[], string | undefined][])("%s", (_name, args, want) => {
    expect(lastFlagValue(flags, args, "jq")).toBe(want);
  });

  test.each([
    ["spaced", ["-q", "abc"], "abc"],
    ["attached", ["-qabc"], "abc"],
    ["after an equals sign", ["-q=abc"], "abc"],
    ["bare equals sign is a value", ["-q="], "="],
    ["no word left", ["-q"], ""],
    ["empty word", ["-q", ""], ""],
    ["clustered after a bool", ["-jq", "abc"], "abc"],
  ] as [string, string[], string | undefined][])("a shorthand: %s", (_name, args, want) => {
    expect(lastFlagValue(flags, args, "query")).toBe(want);
  });
});
