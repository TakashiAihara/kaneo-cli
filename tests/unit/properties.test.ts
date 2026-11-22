import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { nextTag } from "../../scripts/next-tag";
import { decode, parse, STRING, stringMap } from "../../src/config/json";
import { compact, type Json, line } from "../../src/output/json";

// Built from code points: a raw U+2028 in this file would end the line for a
// JavaScript parser.
const ESCAPED = ["<", ">", "&", String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

const hostile = fc.string({ unit: fc.constantFrom(...ESCAPED, '"', "\\", "\n", "\u0001", "a") });

const json = fc.jsonValue() as fc.Arbitrary<Json>;

describe("config JSON parser", () => {
  test("reads every document JSON.parse reads, to the same value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.constantFrom(0, 2), (value, indent) => {
        const text = JSON.stringify(value, null, indent);

        expect(parse(text)).toEqual(JSON.parse(text));
      }),
    );
  });

  // Assigning `__proto__` sets the prototype instead of storing a member. The
  // other names are stored either way and show the order is kept around it.
  const inherited = fc.constantFrom("__proto__", "constructor", "toString", "a");

  test("keeps a key that names something on Object.prototype as a member", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(inherited, fc.jsonValue()), { minLength: 1, selector: ([key]) => key }),
        (members) => {
          const text = `{${members.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",")}}`;

          expect(Object.entries(parse(text) as object)).toEqual(Object.entries(JSON.parse(text)));
          expect(Object.keys(parse(text) as object)).toEqual(members.map(([key]) => key));
        },
      ),
    );
  });

  test("decodes a map under the keys the document gave it", () => {
    fc.assert(
      fc.property(fc.uniqueArray(inherited, { minLength: 1 }), (keys) => {
        const text = `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(key)}`).join(",")}}`;

        expect(Object.entries(decode(parse(text), stringMap(STRING)) as object)).toEqual(keys.map((key) => [key, key]));
      }),
    );
  });
});

describe("output JSON encoder", () => {
  test("compact output parses back to the value it was given", () => {
    fc.assert(
      fc.property(json, (value) => {
        expect(JSON.parse(compact(value))).toEqual(value);
      }),
    );
  });

  test("indented output parses back to the same value as compact output", () => {
    fc.assert(
      fc.property(json, (value) => {
        const text = line(value);

        expect(text.endsWith("\n")).toBe(true);
        expect(JSON.parse(text)).toEqual(JSON.parse(compact(value)));
      }),
    );
  });

  test("writes the short escapes Go writes for a newline, a carriage return and a tab", () => {
    expect(compact("a\nb\rc\td")).toBe('"a\\nb\\rc\\td"');
  });

  test("indents nested values by two spaces and ends with one newline", () => {
    expect(line({ a: [1, {}], b: [] })).toBe('{\n  "a": [\n    1,\n    {}\n  ],\n  "b": []\n}\n');
  });

  test("a string keeps its content and never prints an HTML or line-terminator character raw", () => {
    fc.assert(
      fc.property(hostile, (value) => {
        const text = compact({ [value]: value });

        expect(JSON.parse(text)).toEqual({ [value]: value });
        expect(ESCAPED.filter((char) => text.includes(char))).toEqual([]);
      }),
    );
  });
});

describe("nextTag", () => {
  const tag = fc
    .tuple(fc.nat(12), fc.nat(12), fc.nat(12), fc.option(fc.nat(12)))
    .map(([major, minor, patch, rc]) => `v${major}.${minor}.${patch}${rc === null ? "" : `-rc.${rc}`}`);
  const tags = fc.array(tag, { minLength: 1 });
  const reordered = (list: string[]) => fc.shuffledSubarray(list, { minLength: list.length });

  test("does not depend on the order the tags are listed in", () => {
    fc.assert(
      fc.property(
        tags.chain((list) => fc.tuple(fc.constant(list), reordered(list))),
        ([list, other]) => {
          expect(nextTag(other)).toBe(nextTag(list));
        },
      ),
    );
  });

  test("counts a final version as newer than its own candidates", () => {
    fc.assert(
      fc.property(fc.nat(12), fc.nat(12), fc.nat(12), fc.array(fc.nat(12)), (major, minor, patch, candidates) => {
        const version = `v${major}.${minor}.${patch}`;

        expect(nextTag([version, ...candidates.map((rc) => `${version}-rc.${rc}`)])).toBe(
          `v${major}.${minor}.${patch + 1}-rc.1`,
        );
      }),
    );
  });

  test("returns a tag newer than every tag it was given", () => {
    fc.assert(
      fc.property(tags, (list) => {
        const next = nextTag(list);

        expect(list).not.toContain(next);
        expect(nextTag([next, ...list])).toBe(nextTag([next]));
      }),
    );
  });
});
