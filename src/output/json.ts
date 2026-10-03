// The JSON the Go build wrote, byte for byte.
//
// Go's encoder differs from JSON.stringify where the output is observable: it
// escapes <, > and & as \u00xx so a payload can be embedded in HTML, it always
// escapes the two line terminators a JavaScript parser reads, and a key that
// carries no value at all is left out rather than printed as null. Those are the
// three rules applied here. Key order is the caller's, which is how a struct's
// declared field order and a map's sorted keys are both reproduced without a
// code generator: the objects handed in are already built in the order to print.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };

const HEX = "0123456789abcdef";
const INDENT = "  ";

const string = (value: string): string => {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === "\\") {
      out += `\\${char}`;
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else if (code < 0x20 || code === 0x3c || code === 0x3e || code === 0x26) {
      out += `\\u00${HEX[code >> 4]}${HEX[code & 0xf]}`;
    } else if (code === 0x2028 || code === 0x2029) {
      out += `\\u202${code === 0x2028 ? "8" : "9"}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
};

const number = (value: number): string => (Object.is(value, -0) ? "-0" : String(value));

export const encode = (value: Json, depth = 0): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return number(value);
    case "string":
      return string(value);
  }
  const pad = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${pad}${encode(item, depth + 1)}`).join(",\n")}\n${close}]`;
  }
  const members = Object.entries(value).filter((entry): entry is [string, Json] => entry[1] !== undefined);
  if (members.length === 0) return "{}";
  return `{\n${members.map(([key, item]) => `${pad}${string(key)}: ${encode(item, depth + 1)}`).join(",\n")}\n${close}}`;
};

// One line terminator, as Go's json.Encoder adds after every value it writes.
export const line = (value: Json): string => `${encode(value)}\n`;

// The same encoder without the whitespace or the trailing newline, which is
// what Go's json.Marshal writes. A file another program reads is written this
// way: the indentation above is for a person, and this is for the next read.
export const compact = (value: Json): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return number(value);
    case "string":
      return string(value);
  }
  if (Array.isArray(value)) return `[${value.map(compact).join(",")}]`;
  const members = Object.entries(value).filter((entry): entry is [string, Json] => entry[1] !== undefined);
  return `{${members.map(([key, item]) => `${string(key)}:${compact(item)}`).join(",")}}`;
};
