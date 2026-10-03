import { writeSync } from "node:fs";
import {
  find,
  helpText,
  parsingFlags,
  readFlags,
  unknownCommand,
  usageText,
  type Command,
  type Flag,
} from "./args";
import { deadlineFor, type App } from "./app";
import { resolveFromEnvironment, type Flags as ResolvedFlags } from "../config/resolve";
import { isTTY, resolveMode, Writer } from "../output/output";
import { configureClient } from "../api/http";
import { contextCommand } from "./context";
import { whoamiCommand } from "./whoami";
import { workspaceCommand } from "./workspace";
import { projectCommand } from "./project";
import { taskCommand } from "./task";
import { boardCommand } from "./board";
import { sessionCommand } from "./session";
import { commentCommand } from "./comment";
import { apiCheckCommand } from "./apicheck";
import { completeCommand, completionCommand } from "./completion";

// The version is stamped in at build time; an unreleased build calls itself dev,
// which is what makes it obvious that a report about it belongs to no release.
declare const KANEO_VERSION: string | undefined;
const version = typeof KANEO_VERSION === "undefined" ? "dev" : KANEO_VERSION;

const DEFAULT_TIMEOUT = "10s";

const GLOBAL_FLAGS: Flag[] = [
  { name: "api-url", type: "string", usage: "Kaneo base URL (env KANEO_API_URL)", defaultValue: "" },
  {
    name: "api-key",
    type: "string",
    // A flag is visible in the process list, so the environment is preferred.
    usage: "API key; prefer KANEO_API_KEY, since a flag is visible in the process list",
    defaultValue: "",
  },
  { name: "workspace", shorthand: "w", type: "string", usage: "workspace id (env KANEO_WORKSPACE)", defaultValue: "" },
  { name: "project", shorthand: "p", type: "string", usage: "project id (env KANEO_PROJECT)", defaultValue: "" },
  { name: "json", type: "bool", usage: "force JSON output", defaultValue: "false" },
  { name: "human", type: "bool", usage: "force human-readable output, even through a pipe", defaultValue: "false" },
  { name: "timeout", type: "duration", usage: "per-request timeout", defaultValue: DEFAULT_TIMEOUT },
];

// `help` is a command of its own, the way it is in every cobra-built CLI, and
// prints the same text as --help for whatever it is pointed at.
const helpCommand: Command<App> = {
  name: "help",
  short: "Help about any command",
  use: "help [command]",
  run: ({ args, app: _app }) => {
    const { root } = rootCommand();
    const chain = find(root, args).chain;
    // A topic nobody has is not a failure: the root's usage is what someone
    // typing a wrong name needs, and it goes to stderr beside the complaint.
    if (chain.length === 1 && args.length > 0) {
      writeSync(2, `Unknown help topic [${args.map((word) => `\`${word}\``).join(" ")}]\n`);
      writeSync(2, usageText(chain));
      return;
    }
    writeSync(1, helpText(chain));
  },
};

const rootCommand = (): { root: Command<App> } => {
  const root: Command<App> = {
    name: "kaneo",
    use: "kaneo",
    short: "Command-line client for Kaneo",
    persistent: GLOBAL_FLAGS,
  };
  root.children = [
    contextCommand,
    whoamiCommand,
    workspaceCommand,
    projectCommand,
    taskCommand,
    boardCommand,
    sessionCommand,
    commentCommand,
    apiCheckCommand,
    completionCommand,
    helpCommand,
    // The command the completion scripts call, built against this tree and kept
    // out of the listings.
    completeCommand(root),
  ];
  return { root };
};

const env = (name: string): string => process.env[name] ?? "";
const noColor = (): boolean => env("NO_COLOR") !== "";
const stdoutIsTTY = (): boolean => isTTY(1);

const writerFor = (json: boolean, human: boolean): Writer =>
  new Writer(resolveMode(json, human, stdoutIsTTY(), noColor()));

// Whether the raw arguments asked for a mode. A failure during parsing happens
// before there is a writer, and a script running with --json has to be able to
// parse that failure too, so the mode is recovered from argv; a "--" ends the
// search because everything after it is an argument, not a flag.
const askedFor = (argv: string[], name: string): boolean => {
  for (const arg of argv) {
    if (arg === name) return true;
    if (arg === "--") return false;
  }
  return false;
};

// Runs one invocation and returns the exit code, so the entry point stays a
// single line and the reporting can be checked without leaving the process.
export const run = async (argv: string[]): Promise<number> => {
  const { root } = rootCommand();
  const found = find(root, argv);
  const { chain, command, rest } = found;
  let out: Writer | undefined;

  try {
    // An unknown command is reported before any flag is judged, so a typo is
    // corrected rather than argued with. Only the root refuses one: a group
    // given a word it does not know prints its own help instead.
    if (command.children !== undefined && command.args === undefined && chain.length === 1 && found.words.length > 0) {
      throw unknownCommand(root, chain.map((c) => c.name).join(" "), found.words[0]!);
    }

    const parsed = readFlags(parsingFlags(chain), rest, command);

    // Help wins over everything else on the command line, including --version,
    // and neither reaches the settings.
    if (parsed.flags.help === true) {
      writeSync(1, helpText(chain));
      return 0;
    }
    if (parsed.flags.version === true) {
      writeSync(1, `kaneo version ${version}\n`);
      return 0;
    }
    // A command that only groups others has nothing to run.
    if (command.run === undefined) {
      writeSync(1, helpText(chain));
      return 0;
    }
    command.args?.(parsed.args);

    out = writerFor(parsed.flags.json === true, parsed.flags.human === true);
    // A flag is keyed by the name it was declared with, so a dashed flag only
    // answers to that dashed spelling. Asking for it in any other case misses
    // without complaining and yields "", which reads as "the user did not pass
    // it" and hands the weaker layer a value the flag was meant to beat.
    const flags: ResolvedFlags = {
      apiUrl: String(parsed.flags["api-url"] ?? ""),
      apiKey: String(parsed.flags["api-key"] ?? ""),
      workspaceId: String(parsed.flags.workspace ?? ""),
      projectId: String(parsed.flags.project ?? ""),
    };
    const { cfg, global } = resolveFromEnvironment(flags);
    const timeout = Number(parsed.flags.timeout ?? 0);
    // One deadline for the whole command, as the Go build's app.Context() was one
    // context: the lookups a command makes before it writes and the write itself
    // share one budget, so a slow server cannot use up the time each was given
    // and still have some left for the one that matters.
    const { deadline, deadlineAt } = deadlineFor(timeout);
    const app: App = { cfg, global, out, deadline, deadlineAt };
    configureClient({ baseUrl: cfg.apiUrl, apiKey: cfg.apiKey, timeoutMs: timeout, deadline });

    await command.run({
      args: parsed.args,
      flags: parsed.flags,
      changed: parsed.changed,
      calledAs: found.calledAs,
      app,
    });
    return 0;
  } catch (e) {
    const writer =
      out ?? writerFor(askedFor(argv, "--json"), askedFor(argv, "--human"));
    writer.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
};
