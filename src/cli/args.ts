// Argument parsing, with the Go build's wording.
//
// The build this replaces reported a bad invocation as `Error: unknown flag:
// --nope` and put the same text in its JSON output, so a script parses the line
// itself. The messages are therefore part of the contract, and this reproduces
// them rather than inventing friendlier ones. The shape of the parsing is the
// same: a command is looked up from the non-flag words first, so an unknown
// command is reported before any flag is judged, and the found command then
// parses what is left.

export type FlagType = "string" | "bool" | "duration";

export type Flag = {
  name: string;
  shorthand?: string;
  type: FlagType;
  usage: string;
  // The value the flag's variable starts at. It is printed as "(default ...)"
  // when it is not the type's zero, the way the Go build printed it.
  defaultValue: string;
};

export type FlagValues = Record<string, string | boolean | number>;

export type Command<A> = {
  name: string;
  aliases?: string[];
  short: string;
  long?: string;
  // The usage line, with its arguments: "rename <workspace-id> <name>".
  use?: string;
  // Flags inherited by every command below this one.
  persistent?: Flag[];
  // Flags of this command only.
  flags?: Flag[];
  // Rejects the positional arguments, in the words the Go build used.
  args?: (args: string[]) => void;
  run?: (ctx: RunContext<A>) => void | Promise<void>;
  children?: Command<A>[];
  // Kept out of the listings a person reads, as cobra keeps a hidden command:
  // the shell calls it, so it exists, but nobody has to be shown it.
  hidden?: boolean;
  // Printed without the [flags] the other use lines end in, for a command
  // whose flags are the caller's business rather than part of what is typed.
  noFlagsInUse?: boolean;
  // Handed the words after its own name without a flag being read out of them,
  // which is what lets the completion command be asked about a command line
  // that has flags in it.
  rawArgs?: boolean;
  // Answers with the commands the words after its own name lead to, rather than
  // with its own subcommands: what it completes is named by the line being
  // completed, not by the command doing the completing. The help command is the
  // one that has this, since what it is asked for is the command somebody wants
  // help about.
  completesNamedCommands?: boolean;
};

// Everything a command's body is handed: what was typed, and what was resolved.
export type RunContext<A> = {
  args: string[];
  flags: FlagValues;
  changed: ReadonlySet<string>;
  // The word that named this command, which is one of its aliases when it was
  // reached by one. The lookup takes that word out of the arguments, so a
  // command with two names has nothing else to tell them apart by.
  calledAs: string;
  app: A;
};

const LOWER_HEX = "0123456789abcdef";

// What Go's unicode.IsPrint calls printable: the letter, mark, number,
// punctuation and symbol categories. A rune outside them has no glyph to show,
// so Go spells it out and so must this — a command name read off the terminal is
// only useful if it says which bytes it was made of.
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

// One rune as Go quotes it, given the rune that ends the string.
const escaped = (char: string, delimiter: string): string => {
  if (char === delimiter || char === "\\") return `\\${char}`;
  const code = char.codePointAt(0)!;
  // The printable ASCII range needs no spelling of its own, and the space is in
  // it, which is why it is here rather than in the table above.
  if ((code >= 0x20 && code <= 0x7e) || PRINTABLE.test(char)) return char;
  switch (char) {
    case "\a":
      return "\\a";
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    case "\v":
      return "\\v";
  }
  // Two hex digits for a byte Go cannot show, four for a code point and eight
  // for one outside the basic plane, which is how it names each of them.
  const digits = code < 0x20 || code === 0x7f ? 2 : code < 0x10000 ? 4 : 8;
  const lead = digits === 2 ? "\\x" : digits === 4 ? "\\u" : "\\U";
  let hex = "";
  for (let shift = (digits - 1) * 4; shift >= 0; shift -= 4) hex += LOWER_HEX[(code >>> shift) & 0xf];
  return `${lead}${hex}`;
};

// Go's %q.
//
// Not JSON.stringify, which agrees on every printable character and spells the
// rest differently: a command typed with a control character in it has to be
// reported as the byte it is, and \u0001 reads as a different keyboard than \x01
// does.
const quote = (value: string): string => `"${[...value].map((char) => escaped(char, '"')).join("")}"`;

// The same for a single shorthand letter. pflag quotes it as the rune it is, so
// the single quotes are part of the wording a user sees.
const quoteRune = (letter: string): string => `'${letter}'`;

// A Go duration, in milliseconds. The error messages are Go's, because they are
// what a user sees when they mistype the value.
export const parseDuration = (text: string): number => {
  const invalid = (): Error => new Error(`time: invalid duration ${quote(text)}`);
  let rest = text;
  let negative = false;
  if (rest.startsWith("-") || rest.startsWith("+")) {
    negative = rest.startsWith("-");
    rest = rest.slice(1);
  }
  // Go returns zero for a bare "0" without asking for a unit.
  if (rest === "0") return 0;
  if (rest === "") throw invalid();
  const UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, "μs": 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let ms = 0;
  while (rest !== "") {
    if (!(rest[0] === "." || (rest[0]! >= "0" && rest[0]! <= "9"))) throw invalid();
    const whole = /^\d*/.exec(rest)![0];
    let fraction = 0;
    let scale = 1;
    rest = rest.slice(whole.length);
    if (rest.startsWith(".")) {
      const digits = /^\d*/.exec(rest.slice(1))![0];
      rest = rest.slice(1 + digits.length);
      for (const digit of digits) {
        scale /= 10;
        fraction += Number(digit) * scale;
      }
      if (whole === "" && digits === "") throw invalid();
    }
    const unit = /^[a-zA-Zµμ]+/.exec(rest)?.[0] ?? "";
    if (unit === "") throw new Error(`time: missing unit in duration ${quote(text)}`);
    const factor = UNITS[unit];
    if (factor === undefined) throw new Error(`time: unknown unit ${quote(unit)} in duration ${quote(text)}`);
    rest = rest.slice(unit.length);
    ms += Number(whole) * factor + fraction * factor;
    if (!Number.isFinite(ms) || Math.abs(ms) > Number.MAX_SAFE_INTEGER) throw invalid();
  }
  return negative ? -ms : ms;
};

const parseBool = (text: string): boolean => {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(text)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(text)) return false;
  throw new Error(`strconv.ParseBool: parsing ${quote(text)}: invalid syntax`);
};

// The flags a command was declared with, plus everything its parents made
// persistent. The help and version flags are deliberately absent: they are added
// once a command has been found, so the lookup that found it could not mistake
// `--help` for a flag waiting for a value.
export const declaredFlags = <A>(chain: Command<A>[]): Flag[] => {
  const command = chain[chain.length - 1]!;
  return [
    ...chain.slice(0, -1).flatMap((ancestor) => ancestor.persistent ?? []),
    // The root's persistent flags are its own: nothing above it to hand them
    // down from, so a lookup that left them out would treat `kaneo --json
    // whoami` as a word that names no command.
    ...(command.persistent ?? []),
    ...(command.flags ?? []),
  ];
};

// The same, with the two flags the command carries for itself: every command can
// be asked for help, and the root knows a version.
export const parsingFlags = <A>(chain: Command<A>[]): Flag[] => {
  const command = chain[chain.length - 1]!;
  return [...declaredFlags(chain), helpFlag(command), ...(chain.length === 1 ? [VERSION_FLAG] : [])];
};

// What the help of this command shows as its own flags, and what it shows as the
// ones it inherited. The completion reads the same two sets, in the same order,
// so a shell's menu and the help agree on which flag is whose.
//
// cobra counts a command's persistent flags as its own: nothing above the root
// exists to hand them down from, so they are part of the root's own flags rather
// than an inherited section it cannot have.
export const localFlags = <A>(chain: Command<A>[]): Flag[] => {
  const command = chain[chain.length - 1]!;
  return [
    ...(command.persistent ?? []),
    ...(command.flags ?? []),
    helpFlag(command),
    ...(chain.length === 1 ? [VERSION_FLAG] : []),
  ];
};
export const inheritedFlags = <A>(chain: Command<A>[]): Flag[] =>
  chain.slice(0, -1).flatMap((ancestor) => ancestor.persistent ?? []);

const helpFlag = (command: { name: string }): Flag => ({
  name: "help",
  shorthand: "h",
  type: "bool",
  usage: `help for ${command.name}`,
  defaultValue: "false",
});

const VERSION_FLAG: Flag = {
  name: "version",
  shorthand: "v",
  type: "bool",
  usage: "version for kaneo",
  defaultValue: "false",
};

export type ParsedFlags = { flags: FlagValues; args: string[]; changed: ReadonlySet<string> };

// Reads the words after a command's name.
//
// A command that asked for them raw is handed them as they are: the completion
// command is asked about a command line, and reading a flag out of that line as
// one of its own would throw away the question being asked.
export const readFlags = <A>(flags: Flag[], args: string[], command: Command<A>): ParsedFlags => {
  if (command.rawArgs === true) return { flags: {}, args, changed: new Set() };
  return parseFlags(flags, args);
};

export const parseFlags = (flags: Flag[], args: string[]): ParsedFlags => {
  const byName = new Map(flags.map((flag) => [flag.name, flag]));
  const byShorthand = new Map(flags.flatMap((flag) => (flag.shorthand ? [[flag.shorthand, flag] as const] : [])));
  const values: FlagValues = {};
  // The names of the flags the command line gave a value to. A string flag that
  // was not passed holds its default, which is "" for every flag here, so a
  // passed-but-empty `--description ""` is otherwise indistinguishable from
  // saying nothing at all — and the difference between clearing a description
  // and keeping it is the whole point of that flag.
  const changed = new Set<string>();
  const set = (flag: Flag, raw: string): void => {
    const name = flag.shorthand ? `-${flag.shorthand}, --${flag.name}` : `--${flag.name}`;
    try {
      if (flag.type === "bool") values[flag.name] = parseBool(raw);
      else if (flag.type === "string") values[flag.name] = raw;
      else values[flag.name] = parseDuration(raw);
    } catch (e) {
      throw new Error(`invalid argument ${quote(raw)} for ${quote(name)} flag: ${(e as Error).message}`);
    }
  };
  const given = (flag: Flag, raw: string): void => {
    changed.add(flag.name);
    set(flag, raw);
  };
  for (const flag of flags) set(flag, flag.defaultValue);

  const positional: string[] = [];
  let at = 0;
  const take = (): string | undefined => (at < args.length ? args[at++] : undefined);
  while (at < args.length) {
    const token = args[at++]!;
    // A bare "-" and an empty word are arguments, not flags.
    if (token === "" || !token.startsWith("-") || token.length === 1) {
      positional.push(token);
      continue;
    }
    if (token.startsWith("--")) {
      // "--" ends the flags; the rest is arguments, and they stay arguments
      // even when they look like flags.
      if (token.length === 2) {
        positional.push(...args.slice(at));
        break;
      }
      const name = token.slice(2);
      if (name.startsWith("-") || name.startsWith("=")) throw new Error(`bad flag syntax: ${token}`);
      const equals = name.indexOf("=");
      const flag = byName.get(equals === -1 ? name : name.slice(0, equals));
      if (flag === undefined) throw new Error(`unknown flag: --${equals === -1 ? name : name.slice(0, equals)}`);
      if (equals !== -1) given(flag, name.slice(equals + 1));
      else if (flag.type === "bool") given(flag, "true");
      else {
        const value = take();
        if (value === undefined) throw new Error(`flag needs an argument: ${token}`);
        given(flag, value);
      }
      continue;
    }
    let shorthands = token.slice(1);
    while (shorthands !== "") {
      const letter = shorthands[0]!;
      const flag = byShorthand.get(letter);
      if (flag === undefined) throw new Error(`unknown shorthand flag: ${quoteRune(letter)} in -${shorthands}`);
      const rest = shorthands.slice(1);
      if (rest.length > 1 && rest[0] === "=") {
        given(flag, rest.slice(1));
        shorthands = "";
      } else if (flag.type === "bool") {
        given(flag, "true");
        shorthands = rest;
      } else if (rest !== "") {
        // -pvalue and -p=value both carry the value in the same word.
        given(flag, rest);
        shorthands = "";
      } else {
        const value = take();
        if (value === undefined) throw new Error(`flag needs an argument: ${quoteRune(letter)} in -${shorthands}`);
        given(flag, value);
        // The rest of the word held no further shorthand; only a value flag can
        // leave it empty, so nothing is left to read.
        shorthands = "";
      }
    }
  }
  return { flags: values, args: positional, changed };
};

const hasNoValue = (flags: Flag[], name: string): boolean =>
  flags.some((flag) => flag.name === name && flag.type === "bool");
const hasShorthandNoValue = (flags: Flag[], letter: string): boolean =>
  flags.some((flag) => flag.shorthand === letter && flag.type === "bool");

// The words that are not flags, or the value of one. A word that names no
// command is the end of the lookup; a flag whose value is missing ends it too,
// since there is nothing left to look at.
const wordsOf = (args: string[], flags: Flag[]): string[] => {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") break;
    if (token.startsWith("--") && !token.includes("=") && !hasNoValue(flags, token.slice(2))) {
      if (args.length - i - 1 <= 0) break;
      i++;
      continue;
    }
    if (token.startsWith("-") && !token.startsWith("--") && token.length === 2 && !hasShorthandNoValue(flags, token[1]!)) {
      if (args.length - i - 1 <= 0) break;
      i++;
      continue;
    }
    if (token !== "" && !token.startsWith("-")) words.push(token);
  }
  return words;
};

const dropFirst = (args: string[], word: string, flags: Flag[]): string[] => {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token === "--") break;
    if (token.startsWith("--") && !token.includes("=") && !hasNoValue(flags, token.slice(2))) {
      i++;
      continue;
    }
    if (token.startsWith("-") && !token.startsWith("--") && token.length === 2 && !hasShorthandNoValue(flags, token[1]!)) {
      i++;
      continue;
    }
    if (!token.startsWith("-") && token === word) return [...args.slice(0, i), ...args.slice(i + 1)];
  }
  return args;
};

export type Found<A> = {
  chain: Command<A>[];
  command: Command<A>;
  // The word the command was reached by, which is an alias when it was called by
  // one: the lookup drops that word from the arguments, so a command whose names
  // answer to different things has only this to tell them apart by.
  calledAs: string;
  // What is left of argv once the command names are taken out.
  rest: string[];
  // The words that were not flags, for the unknown-command report.
  words: string[];
};

export const find = <A>(root: Command<A>, argv: string[]): Found<A> => {
  const chain: Command<A>[] = [root];
  let rest = argv;
  let calledAs = root.name;
  for (;;) {
    const words = wordsOf(rest, declaredFlags(chain));
    const next = words[0];
    if (next === undefined) break;
    const child = chain[chain.length - 1]!.children?.find((c) => c.name === next || c.aliases?.includes(next));
    if (child === undefined) break;
    rest = dropFirst(rest, next, declaredFlags(chain));
    chain.push(child);
    calledAs = next;
  }
  return { chain, command: chain[chain.length - 1]!, calledAs, rest, words: wordsOf(rest, declaredFlags(chain)) };
};

export const noArgs = (path: string): ((args: string[]) => void) => (args) => {
  const first = args[0];
  if (first !== undefined) throw new Error(`unknown command ${quote(first)} for ${quote(path)}`);
};

export const minimumArgs =
  (count: number): ((args: string[]) => void) =>
  (args) => {
    if (args.length < count) throw new Error(`requires at least ${count} arg(s), only received ${args.length}`);
  };

export const maximumArgs =
  (count: number): ((args: string[]) => void) =>
  (args) => {
    if (args.length > count) throw new Error(`accepts at most ${count} arg(s), received ${args.length}`);
  };

export const exactArgs =
  (count: number): ((args: string[]) => void) =>
  (args) => {
    if (args.length !== count) throw new Error(`accepts ${count} arg(s), received ${args.length}`);
  };

export const rangeArgs =
  (min: number, max: number): ((args: string[]) => void) =>
  (args) => {
    if (args.length < min || args.length > max) {
      throw new Error(`accepts between ${min} and ${max} arg(s), received ${args.length}`);
    }
  };

const available = <A>(command: Command<A>): Command<A>[] =>
  (command.children ?? [])
    .filter((child) => child.hidden !== true && (child.run !== undefined || (child.children?.length ?? 0) > 0))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export const unknownCommand = <A>(command: Command<A>, path: string, word: string): Error => {
  const suggestions = available(command)
    .filter((child) => distance(word.toLowerCase(), child.name.toLowerCase()) <= 2 || child.name.toLowerCase().startsWith(word.toLowerCase()))
    .map((child) => child.name);
  const hint =
    suggestions.length === 0
      ? ""
      : `\n\nDid you mean this?\n${suggestions.map((s) => `\t${s}\n`).join("")}`;
  return new Error(`unknown command ${quote(word)} for ${quote(path)}${hint}`);
};

const distance = (from: string, to: string): number => {
  let row = Array.from({ length: to.length + 1 }, (_, i) => i);
  for (let i = 1; i <= from.length; i++) {
    const next = [i];
    for (let j = 1; j <= to.length; j++) {
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (from[i - 1] === to[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[to.length]!;
};

const isZero = (flag: Flag): boolean => {
  switch (flag.type) {
    case "bool":
      return flag.defaultValue === "false";
    case "duration":
      try {
        return parseDuration(flag.defaultValue) === 0;
      } catch {
        return false;
      }
    default:
      return flag.defaultValue === "";
  }
};

// How a flag's default is written in its usage line.
//
// pflag quotes a string's default and prints anything else as it stands: a
// duration's default is already the text it is shown as, and quoting "10s" would
// read as a duration being a string.
const printed = (flag: Flag): string => (flag.type === "string" ? quote(flag.defaultValue) : flag.defaultValue);

// The flag block, aligned on the usage text: the widest flag decides where
// every description starts, and every line ends in the same column.
const flagUsages = (flags: Flag[]): string => {
  const sorted = [...flags].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const described = sorted.map((flag) => {
    const head = flag.shorthand ? `  -${flag.shorthand}, --${flag.name}` : `      --${flag.name}`;
    const type = flag.type === "bool" ? "" : ` ${flag.type}`;
    const tail = isZero(flag) ? flag.usage : `${flag.usage} (default ${printed(flag)})`;
    return `${head}${type}\x00${tail}`;
  });
  const width = Math.max(...described.map((line) => line.indexOf("\x00") + 1));
  return described
    .map((line) => {
      const at = line.indexOf("\x00");
      return `${line.slice(0, at)} ${" ".repeat(width - at)} ${line.slice(at + 1)}`;
    })
    .join("\n");
};

const trimEnd = (text: string): string => text.replace(/\s+$/, "");

// The command's own path with its arguments: "kaneo workspace rename
// <workspace-id> <name> [flags]". The [flags] is there because every command
// carries at least a help flag, except the few that say their flags are the
// caller's business.
const useLine = <A>(chain: Command<A>[]): string => {
  const command = chain[chain.length - 1]!;
  const use = command.use ?? command.name;
  const line = `${chain.slice(0, -1).map((c) => c.name).join(" ")}${chain.length === 1 ? "" : " "}${use}`;
  if (command.noFlagsInUse === true || line.includes("[flags]")) return line;
  return `${line} [flags]`;
};

export const usageText = <A>(chain: Command<A>[]): string => {
  const command = chain[chain.length - 1]!;
  const path = chain.map((c) => c.name).join(" ");
  const subcommands = available(command);
  const sections: string[] = [];

  let usage = "Usage:";
  if (command.run !== undefined) usage += `\n  ${useLine(chain)}`;
  if (subcommands.length > 0) usage += `\n  ${path} [command]`;
  sections.push(usage);

  if ((command.aliases?.length ?? 0) > 0) sections.push(`Aliases:\n  ${[command.name, ...command.aliases!].join(", ")}`);
  if (subcommands.length > 0) {
    const padding = Math.max(11, ...subcommands.map((c) => c.name.length));
    const lines = subcommands.map((c) => `  ${c.name.padEnd(padding)} ${c.short}`);
    sections.push(`Available Commands:\n${lines.join("\n")}`);
  }
  const local = localFlags(chain);
  if (local.length > 0) sections.push(`Flags:\n${flagUsages(local)}`);
  const inherited = inheritedFlags(chain);
  if (inherited.length > 0) sections.push(`Global Flags:\n${flagUsages(inherited)}`);
  if (subcommands.length > 0) sections.push(`Use "${path} [command] --help" for more information about a command.`);

  return `${sections.join("\n\n")}\n`;
};

export const helpText = <A>(chain: Command<A>[]): string => {
  const command = chain[chain.length - 1]!;
  return `${trimEnd(command.long ?? command.short)}\n\n${usageText(chain)}`;
};
