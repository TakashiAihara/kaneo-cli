import { writeSync } from "node:fs";
import { find, noArgs, type Command, type Flag, type FlagValues } from "./args";
import type { App } from "./app";
import { activeHelpVar, bashScript, fishScript, powershellScript, zshScript, type Program } from "./completion-scripts";

// The shell-completion command tree cobra gives every program that has
// subcommands, and the hidden command the scripts it generates call back into.
//
// The scripts are cobra's, from the same templates, so a shell that has already
// sourced one keeps working. The hidden command is what makes them offer
// anything: without it the four scripts would be decoration.

// The hidden command's name, and the second name the same command answers to
// when descriptions were turned off. One command with two names, because the
// difference is only in what it prints.
const COMPLETE = "__complete";
const COMPLETE_NO_DESC = "__completeNoDesc";

// What a shell reads off the last line of a candidate list: the bitmask that
// tells it whether to complete file names too. Every generated script knows
// these numbers.
const DIRECTIVE_DEFAULT = 0;
const DIRECTIVE_NO_FILE_COMPLETION = 4;

const PROGRAM_NAME = "kaneo";

const noDescriptionsFlag: Flag = {
  name: "no-descriptions",
  type: "bool",
  usage: "disable completion descriptions",
  defaultValue: "false",
};

type Shell = "bash" | "fish" | "powershell" | "zsh";

const BASH_LONG = `
Generate the autocompletion script for the bash shell.

This script depends on the 'bash-completion' package.
If it is not installed already, you can install it via your OS's package manager.

To load completions in your current shell session:

	source <(kaneo completion bash)

To load completions for every new session, execute once:

#### Linux:

	kaneo completion bash > /etc/bash_completion.d/kaneo

#### macOS:

	kaneo completion bash > $(brew --prefix)/etc/bash_completion.d/kaneo

You will need to start a new shell for this setup to take effect.
`;

const ZSH_LONG = `
Generate the autocompletion script for the zsh shell.

If shell completion is not already enabled in your environment you will need
to enable it.  You can execute the following once:

	echo "autoload -U compinit; compinit" >> ~/.zshrc

To load completions in your current shell session:

	source <(kaneo completion zsh)

To load completions for every new session, execute once:

#### Linux:

	kaneo completion zsh > "\${fpath[1]}/_kaneo"

#### macOS:

	kaneo completion zsh > $(brew --prefix)/share/zsh/site-functions/_kaneo

You will need to start a new shell for this setup to take effect.
`;

const FISH_LONG = `
Generate the autocompletion script for the fish shell.

To load completions in your current shell session:

	kaneo completion fish | source

To load completions for every new session, execute once:

	kaneo completion fish > ~/.config/fish/completions/kaneo.fish

You will need to start a new shell for this setup to take effect.
`;

const POWERSHELL_LONG = `
Generate the autocompletion script for powershell.

To load completions in your current shell session:

	kaneo completion powershell | Out-String | Invoke-Expression

To load completions for every new session, add the output of the above command
to your powershell profile.
`;

const scriptFor = (shell: Shell, program: Program): string => {
  switch (shell) {
    case "bash":
      return bashScript(program);
    case "zsh":
      return zshScript(program);
    case "fish":
      return fishScript(program);
    case "powershell":
      return powershellScript(program);
  }
};

const programFor = (descriptions: boolean): Program => ({
  name: PROGRAM_NAME,
  activeHelp: activeHelpVar(PROGRAM_NAME),
  compCmd: descriptions ? COMPLETE : COMPLETE_NO_DESC,
});

const shellCommand = (shell: Shell, long: string): Command<App> => ({
  name: shell,
  short: `Generate the autocompletion script for ${shell}`,
  long: long.trim(),
  // cobra prints these use lines without the [flags] every other command ends
  // in: --no-descriptions is there for whoever generates the script, not for
  // whoever types this one.
  noFlagsInUse: true,
  args: noArgs(`kaneo completion ${shell}`),
  flags: [noDescriptionsFlag],
  run: ({ flags }: { flags: FlagValues }) => {
    writeSync(1, scriptFor(shell, programFor(flags["no-descriptions"] !== true)));
  },
});

export const completionCommand: Command<App> = {
  name: "completion",
  short: "Generate the autocompletion script for the specified shell",
  long:
    "Generate the autocompletion script for kaneo for the specified shell.\n" +
    "See each sub-command's help for details on how to use the generated script.",
  args: noArgs("kaneo completion"),
  children: [
    shellCommand("bash", BASH_LONG),
    shellCommand("fish", FISH_LONG),
    shellCommand("powershell", POWERSHELL_LONG),
    shellCommand("zsh", ZSH_LONG),
  ],
};

// The command the generated scripts call, built against the tree it completes.
//
// The root is passed in rather than reached for: the tree is built in one place
// and the answer has to come from that same tree, or a command could complete
// against a tree nobody is running.
export const completeCommand = (root: Command<App>): Command<App> => ({
  name: COMPLETE,
  aliases: [COMPLETE_NO_DESC],
  short: "Request shell completion choices for the specified command-line",
  long: `${COMPLETE} is a special command that is used by the shell completion logic\nto request completion choices for the specified command-line.`,
  // Hidden: a shell calls it, so it has to exist, but nobody types it.
  hidden: true,
  // Nothing after its name is a flag of its own: those words are the command
  // line being completed, and reading a --json in it as this command's flag
  // would drop the line the shell is asking about.
  rawArgs: true,
  args: (args) => {
    if (args.length === 0) throw new Error("requires at least 1 arg(s), only received 0");
  },
  run: ({ args, app: _app }) => {
    // The name it was reached by says whether the descriptions are wanted, so
    // the difference is read out of the words rather than a flag.
    const descriptions = !args.includes(COMPLETE_NO_DESC);
    // The last word is the one being completed: a partial word or an empty one,
    // neither of which names a command yet.
    const typed = args.slice(0, -1);
    const partial = args[args.length - 1] ?? "";
    const { chain } = find(root, typed);
    const command = chain[chain.length - 1]!;
    const lines = partial.startsWith("-") ? flagLines(command, chain, typed, partial) : commandLines(command, partial);
    for (const word of lines) writeSync(1, `${descriptions ? word : word.split("\t")[0]!}\n`);
    // A command that offers subcommands of its own is finished with those, so
    // the shell is told not to fall back to listing the directory as well.
    const directive = (command.children ?? []).length > 0 ? DIRECTIVE_NO_FILE_COMPLETION : DIRECTIVE_DEFAULT;
    writeSync(1, `:${directive}\n`);
  },
});

// One candidate per line: the word, then a tab and what it means, which is the
// shape the generated scripts split the answer on.
const candidate = (word: string, description: string): string => `${word}\t${description}`;

// The commands below this one, each with what it is for. Aliases are not offered:
// a shell that completes a name nobody can type has been told something false, and
// cobra completes the names alone for the same reason.
const commandLines = (command: Command<App>, partial: string): string[] => {
  const found: [string, string][] = [];
  for (const child of command.children ?? []) {
    if (child.hidden === true) continue;
    if (child.name.startsWith(partial)) found.push([child.name, child.short]);
  }
  return sorted(found).map(([word, description]) => candidate(word, description));
};

// A flag is offered under both its spellings. One already written on the line is
// not offered again, since repeating it is never what is meant.
const flagLines = (
  command: Command<App>,
  chain: Command<App>[],
  typed: string[],
  partial: string,
): string[] => {
  const offered = [
    ...chain.slice(0, -1).flatMap((at) => at.persistent ?? []),
    ...(command.persistent ?? []),
    ...(command.flags ?? []),
    // Every command can be asked for help, so that is a completion as well.
    { name: "help", shorthand: "h", type: "bool" as const, usage: `help for ${command.name}`, defaultValue: "false" },
  ];
  const given = alreadyGiven(typed, offered);
  const found: [string, string][] = [];
  for (const flag of offered) {
    if (given.has(flag.name)) continue;
    const long = `--${flag.name}`;
    if (long.startsWith(partial)) found.push([long, flag.usage]);
    if (flag.shorthand !== undefined && `-${flag.shorthand}`.startsWith(partial)) {
      found.push([`-${flag.shorthand}`, flag.usage]);
    }
  }
  return sorted(found).map(([word, description]) => candidate(word, description));
};

// The flags already written on the line, read off it the way the lookup that
// found the command read it: a long spelling by name, a short one by its letter,
// and anything after an "=" is the value rather than part of the flag.
const alreadyGiven = (typed: string[], offered: Flag[]): Set<string> => {
  const byShorthand = new Map(offered.flatMap((flag) => (flag.shorthand ? [[flag.shorthand, flag.name] as const] : [])));
  const known = new Set(offered.map((flag) => flag.name));
  const given = new Set<string>();
  for (const word of typed) {
    if (!word.startsWith("-") || word.length < 2) continue;
    const token = word.split("=")[0]!;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (known.has(name)) given.add(name);
      continue;
    }
    for (const letter of token.slice(1)) {
      const name = byShorthand.get(letter);
      if (name !== undefined) given.add(name);
    }
  }
  return given;
};

// Sorted the way the help lists them, so a shell's menu and `kaneo --help` agree.
const sorted = (pairs: [string, string][]): [string, string][] =>
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));