// encoding/json, closely enough for a config file.
//
// The Go build read these files with encoding/json and reported what it said, so
// the wording is the contract: someone who hand-edited a config has seen
// `invalid character 'n' looking for beginning of object key string` and will
// look for it again. Three of its behaviours are reproduced here because they
// decide whether a config is read at all:
//
//   - a key is matched without regard to case, so `Default_Profile` and
//     `default_profile` are the same setting. A config is written by hand and
//     synced between machines, and a key that silently stops working is how a
//     setting is lost without anyone noticing.
//   - a field the document does not carry is left at Go's zero value rather than
//     being an error, and so is an explicit null: a server or an older file
//     leaving something out is not a reason to refuse to read the rest.
//   - a field of the wrong type is an error naming the struct, the path to the
//     field and the type it should have been, because a config that means
//     something else is worse than one that is refused.

// A JSON document, as a value: what json.Unmarshal would have built.
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

// The Go types a config file is decoded into, as far as an error has to name
// them.
export type GoType =
  | { at: "string" | "bool" }
  | { at: "struct"; name: string; fields: Field[] }
  | { at: "map"; value: GoType }
  | { at: "slice"; value: GoType }
  // A named type with its own UnmarshalJSON, which decodes more than one shape
  // and complains in its own words when neither fits.
  | { at: "either"; name: string; of: GoType[]; complaint: string };

export type Field = { name: string; type: GoType };

export const STRING: GoType = { at: "string" };

export const stringMap = (value: GoType): GoType => ({ at: "map", value });

// Where the decoder is, for a message that names it: the struct whose field was
// being read, and the fields walked to reach it.
type Where = { struct: string; fields: string[] };

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

// Parses a document, or throws the syntax error Go's scanner would have.
//
// The scanner is a state machine, so the wording depends on where the byte it
// choked on sits: a stray letter where a key belongs is a different complaint
// from one where a value belongs, and only the second says nothing about which
// key was being written.
export const parse = (text: string): Value => new Parser(text).document();

// Reads a document into the shape its Go type describes, or throws the type
// error Go would have.
export const decode = (value: Value, type: GoType, at: Where = { struct: "", fields: [] }): unknown =>
  decodeValue(value, type, at);

class Parser {
  private at = 0;

  constructor(private readonly text: string) {}

  document(): Value {
    this.skipSpace();
    const value = this.value();
    this.skipSpace();
    if (!this.done) invalid(this.peek(), "after top-level value");
    return value;
  }

  private get done(): boolean {
    return this.at >= this.text.length;
  }

  private peek(): string {
    return this.text[this.at]!;
  }

  private skipSpace(): void {
    while (!this.done && WHITESPACE.has(this.peek())) this.at += 1;
  }

  private value(): Value {
    this.skipSpace();
    if (this.done) return unexpectedEnd();
    const char = this.peek();
    switch (char) {
      case "{":
        return this.object();
      case "[":
        return this.array();
      case '"':
        return this.string();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (char === "-" || (char >= "0" && char <= "9")) return this.number();
        return invalid(char, "looking for beginning of value");
    }
  }

  private object(): Value {
    this.at += 1;
    const out: { [key: string]: Value } = {};
    this.skipSpace();
    if (this.done) return unexpectedEnd();
    if (this.peek() === "}") {
      this.at += 1;
      return out;
    }
    for (;;) {
      this.skipSpace();
      if (this.done) return unexpectedEnd();
      if (this.peek() !== '"') return invalid(this.peek(), "looking for beginning of object key string");
      const key = this.string();
      this.skipSpace();
      if (this.done) return unexpectedEnd();
      if (this.peek() !== ":") return invalid(this.peek(), "after object key");
      this.at += 1;
      out[key] = this.value();
      this.skipSpace();
      if (this.done) return unexpectedEnd();
      const after = this.peek();
      if (after === ",") {
        this.at += 1;
        continue;
      }
      if (after === "}") {
        this.at += 1;
        return out;
      }
      return invalid(after, "after object key:value pair");
    }
  }

  private array(): Value {
    this.at += 1;
    const out: Value[] = [];
    this.skipSpace();
    if (this.done) return unexpectedEnd();
    if (this.peek() === "]") {
      this.at += 1;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.skipSpace();
      if (this.done) return unexpectedEnd();
      const after = this.peek();
      if (after === ",") {
        this.at += 1;
        continue;
      }
      if (after === "]") {
        this.at += 1;
        return out;
      }
      return invalid(after, "after array element");
    }
  }

  private string(): string {
    this.at += 1;
    let out = "";
    for (;;) {
      if (this.done) return unexpectedEnd();
      const char = this.peek();
      this.at += 1;
      if (char === '"') return out;
      if (char === "\\") {
        out += this.escape();
        continue;
      }
      // A raw control character is not allowed unescaped, and a newline inside a
      // string is the usual way a hand-written config goes wrong.
      if (char < " ") return invalid(char, "in string literal");
      out += char;
    }
  }

  private escape(): string {
    if (this.done) return unexpectedEnd();
    const char = this.peek();
    this.at += 1;
    switch (char) {
      case '"':
      case "\\":
      case "/":
        return char;
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.text.slice(this.at, this.at + 4);
        if (hex.length < 4) return unexpectedEnd();
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // The first character that is not part of the escape is the one Go
          // complains about.
          for (let i = 0; i < 4; i++) {
            const at = hex[i]!;
            if (!/[0-9a-fA-F]/.test(at)) return invalid(at, "in \\u hexadecimal character escape");
          }
        }
        this.at += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        return invalid(char, "in string escape code");
    }
  }

  private literal(word: string, value: Value): Value {
    for (const char of word) {
      if (this.done) return unexpectedEnd();
      const got = this.peek();
      if (got !== char) return invalid(got, `in literal ${word} (expecting '${char}')`);
      this.at += 1;
    }
    return value;
  }

  // The number is scanned rather than matched, so that whatever stops it is
  // named by the state that follows: a '.' where a digit belongs is a complaint
  // about the number, while a second '.' is a complaint about what came after
  // the value, and Go words those two differently.
  private number(): Value {
    const start = this.at;
    if (this.peek() === "-") this.at += 1;
    if (this.done) return unexpectedEnd();
    // A leading zero is the whole integer part; 01 is a zero followed by
    // something, and Go reads it that way.
    if (this.peek() === "0") this.at += 1;
    else if (this.digits() === 0) return this.bad("in numeric literal");
    if (!this.done && this.peek() === ".") {
      this.at += 1;
      this.digits();
    }
    if (!this.done && (this.peek() === "e" || this.peek() === "E")) {
      this.at += 1;
      if (!this.done && (this.peek() === "+" || this.peek() === "-")) this.at += 1;
      if (this.digits() === 0) return this.bad("in exponent of numeric literal");
    }
    return Number(this.text.slice(start, this.at));
  }

  private digits(): number {
    let seen = 0;
    while (!this.done && this.peek() >= "0" && this.peek() <= "9") {
      this.at += 1;
      seen += 1;
    }
    return seen;
  }

  // The complaint names the byte the scanner stood on, or the end of the input
  // when the file stopped there.
  private bad(context: string): never {
    if (this.done) return unexpectedEnd();
    return invalid(this.peek(), context);
  }
}

// Go quotes the byte it stopped at, and says nothing more about it.
const quoteChar = (char: string): string => {
  if (char === "'") return "'\\''";
  if (char === '"') return `'"'`;
  const escaped = JSON.stringify(char).slice(1, -1);
  return `'${escaped}'`;
};

const invalid = (char: string, context: string): never => {
  throw new Error(`invalid character ${quoteChar(char)} ${context}`);
};

const unexpectedEnd = (): never => {
  throw new Error("unexpected end of JSON input");
};

const isRecord = (value: Value): value is { [key: string]: Value } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// What Go calls the value it was given, in an error about it.
const kindOf = (value: Value): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "bool";
    default:
      return "object";
  }
};

const goName = (type: GoType): string => {
  switch (type.at) {
    case "struct":
      return `config.${type.name}`;
    case "map":
      return `map[string]${goName(type.value)}`;
    case "slice":
      return `[]${goName(type.value)}`;
    case "either":
      return `config.${type.name}`;
    default:
      return type.at;
  }
};

const decodeValue = (value: Value, type: GoType, at: Where): unknown => {
  // A null leaves the destination as it was, which for a field read into a
  // struct means the zero value rather than an error.
  if (value === null) return null;

  switch (type.at) {
    case "string":
      if (typeof value !== "string") throw mismatch(value, type, at);
      return value;
    case "bool":
      if (typeof value !== "boolean") throw mismatch(value, type, at);
      return value;
    case "slice": {
      if (!Array.isArray(value)) throw mismatch(value, type, at);
      return value.map((entry) => decodeValue(entry, type.value, at));
    }
    case "map": {
      if (!isRecord(value)) throw mismatch(value, type, at);
      const out: { [key: string]: unknown } = {};
      for (const [key, entry] of Object.entries(value)) {
        // A map key is part of the path a type error names, because it is the
        // only way to say which entry of the map was wrong.
        out[key] = decodeValue(entry, type.value, { struct: at.struct, fields: [...at.fields, key] });
      }
      return out;
    }
    case "struct": {
      if (!isRecord(value)) throw mismatch(value, type, at);
      const out: { [key: string]: unknown } = {};
      for (const [key, entry] of Object.entries(value)) {
        const field = fieldFor(type, key);
        // A key this build does not know is ignored, as Go ignores it: the file
        // is synced between machines that may be running different builds.
        if (field === undefined) continue;
        out[field.name] = decodeValue(entry, field.type, {
          struct: type.name,
          fields: [...at.fields, field.name],
        });
      }
      return out;
    }
    case "either": {
      // A type that decodes more than one shape tries each in turn and reports
      // the first failure, which is the shape it would rather have had.
      let first: Error | undefined;
      for (const option of type.of) {
        try {
          return decodeValue(value, option, at);
        } catch (e) {
          first ??= e as Error;
        }
      }
      throw new Error(`${type.complaint}: ${first?.message ?? mismatch(value, type, at).message}`);
    }
  }
};

// An exact match wins; failing that, the same name in any case. Go falls back
// this way so a key written with different capitals still finds its field.
const fieldFor = (type: Extract<GoType, { at: "struct" }>, key: string): Field | undefined =>
  type.fields.find((field) => field.name === key) ??
  type.fields.find((field) => field.name.toLowerCase() === key.toLowerCase());

const mismatch = (value: Value, type: GoType, at: Where): Error => {
  if (at.struct === "" || at.fields.length === 0) {
    return new Error(`json: cannot unmarshal ${kindOf(value)} into Go value of type ${goName(type)}`);
  }
  return new Error(
    `json: cannot unmarshal ${kindOf(value)} into Go struct field ${at.struct}.${at.fields.join(".")} of type ${goName(type)}`,
  );
};