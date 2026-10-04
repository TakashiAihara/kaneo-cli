import { writeSync } from "node:fs";
import { declaredFlags, find, inheritedFlags, localFlags, noArgs, type Command, type Flag, type FlagValues, type RunContext } from "./args";
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

// What a shell reads off the last line of a candidate list, and what that same
// directive is called on stderr, where a person is the one reading. The number
// is the bit that tells the shell whether to complete file names too; every
// generated script knows the numbers.
const DIRECTIVES = {
  default: { bit: 0, name: "ShellCompDirectiveDefault" },
  noFileCompletion: { bit: 4, name: "ShellCompDirectiveNoFileComp" },
} as const;

type Directive = (typeof DIRECTIVES)[keyof typeof DIRECTIVES];

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
  // Only bash. cobra's completion tree sets this on that one command and leaves
  // the other three alone, so their use lines end in [flags] and its does not.
  // The help is the Go build's word for word, that difference included.
  noFlagsInUse: shell === "bash",
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
  run: ({ args, calledAs, app: _app }: RunContext<App>) => {
    // The name it was reached by says whether the descriptions are wanted, so
    // the difference is read out of the name rather than out of the arguments,
    // which hold only the command line being completed.
    const descriptions = calledAs !== COMPLETE_NO_DESC;
    // The last word is the one being completed: a partial word or an empty one,
    // neither of which names a command yet.
    const typed = args.slice(0, -1);
    const partial = args[args.length - 1] ?? "";
    const { chain, rest, words } = find(root, typed);
    const command = chain[chain.length - 1]!;

    let lines: string[] = [];
    // The shell is told to fall back on its own idea of what to do unless the
    // answer rules that out: only a name the program knows, or a flag name, is
    // something a file can never be.
    let directive: Directive = DIRECTIVES.default;

    if (chain.length === 1 && words.length > 0) {
      // A word that names no command ends the lookup, and cobra says so where
      // whoever ran the line by hand can read it. The shell ignores stderr and
      // is told only that nothing is on offer.
      writeSync(2, `[Debug] [Error] unable to find a command for arguments: [${typed.join(" ")}]\n`);
    } else if (expectsValue(chain, rest)) {
      // The word being completed is the value of the flag before it. Nothing is
      // on offer for one, and the shell is left to fall back: a flag's value is
      // whatever the flag says it takes, which only the program can answer, and
      // a file name is the one answer that is always wrong.
    } else if (command.completesNamedCommands === true) {
      // The command whose name is being completed is the one the words after
      // its own name lead to, not one of its own subcommands, so the lookup is
      // done against the tree as though this command were not there. A name
      // nobody has leaves nothing to complete.
      const named = find(root, rest);
      if (named.chain.length > 1 || rest.length === 0) lines = commandLines(named.command, partial);
      directive = DIRECTIVES.noFileCompletion;
    } else if (partial.startsWith("-")) {
      // A flag name is never followed by a file name, so the shell is told to
      // stop there whether or not anything matched.
      lines = flagLines(chain, typed, partial);
      directive = DIRECTIVES.noFileCompletion;
    } else {
      // A command that offers subcommands of its own is finished with those,
      // which is the same answer as for a flag name.
      lines = commandLines(command, partial);
      if ((command.children ?? []).length > 0) directive = DIRECTIVES.noFileCompletion;
    }

    for (const word of lines) writeSync(1, `${descriptions ? word : word.split("\t")[0]!}\n`);
    writeSync(1, `:${directive.bit}\n`);
    // A shell reads stdout and ignores stderr, so the directive is reported a
    // second time where whoever ran the command by hand can see which one it was.
    writeSync(2, `Completion ended with directive: ${directive.name}\n`);
  },
});

// Whether the word being completed is a flag's value, which the word before it
// gives away: a flag that takes one leaves nothing to offer, and a flag that
// takes none is a flag name again rather than a value.
const expectsValue = (chain: Command<App>[], rest: string[]): boolean => {
  const previous = rest[rest.length - 1];
  if (previous === undefined || previous.includes("=")) return false;
  const name = flagNamed(previous);
  if (name === undefined) return false;
  return declaredFlags(chain).some((flag) => (flag.name === name || flag.shorthand === name) && flag.type !== "bool");
};

// The flag a word names, or undefined when the word is not one. A long spelling
// carries the name itself and a short one only its last letter, which is the one
// a cluster of shorthands has reached.
const flagNamed = (word: string): string | undefined => {
  if (word.startsWith("--")) return word.length > 2 ? word.slice(2) : undefined;
  if (word.startsWith("-") && word.length > 1 && word[1] !== "-") return word[word.length - 1];
  return undefined;
};

// One candidate per line: the word, then a tab and what it means, which is the
// shape the generated scripts split the answer on.
const candidate = (word: string, description: string): string => `${word}\t${description}`;

// The commands below this one, each with what it is for. Aliases are not offered:
// a shell that completes a name nobody can type has been told something false, and
// cobra completes the names alone for the same reason.
//
// Sorted the way the help lists them, so a shell's menu and `kaneo --help` agree.
const commandLines = (command: Command<App>, partial: string): string[] =>
  (command.children ?? [])
    .filter((child) => child.hidden !== true)
    .sort(byName)
    .filter((child) => child.name.startsWith(partial))
    .map((child) => candidate(child.name, child.short));

// A flag is offered under both its spellings. One already written on the line is
// not offered again, since repeating it is never what is meant.
//
// The inherited set comes before the command's own, each sorted by name, which is
// the order the help prints the two sections in.
const flagLines = (chain: Command<App>[], typed: string[], partial: string): string[] => {
  const inherited = inheritedFlags(chain);
  const own = localFlags(chain);
  const given = alreadyGiven(typed, [...inherited, ...own]);
  return [...flagNames(inherited, given, partial), ...flagNames(own, given, partial)];
};

const flagNames = (flags: Flag[], given: ReadonlySet<string>, partial: string): string[] => {
  const found: string[] = [];
  for (const flag of [...flags].sort(byName)) {
    if (given.has(flag.name)) continue;
    const long = `--${flag.name}`;
    if (long.startsWith(partial)) found.push(candidate(long, flag.usage));
    if (flag.shorthand !== undefined && `-${flag.shorthand}`.startsWith(partial)) {
      found.push(candidate(`-${flag.shorthand}`, flag.usage));
    }
  }
  return found;
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
const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;