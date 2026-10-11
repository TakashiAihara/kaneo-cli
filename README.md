# kaneo

Command-line client for [Kaneo](https://github.com/usekaneo/kaneo), the self-hostable project management tool.

A single self-contained binary, no runtime to install. Ships for `linux/amd64`, `linux/arm64`, `darwin/arm64` and `darwin/amd64`; the Linux builds need glibc.

## Status

Early. The command surface below is what exists today; the rest of the API is not wired up yet.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/kaneo-cli/main/install.sh | sh
```

Installs the latest release into `$HOME/.local/bin`, and tells you if that is not on your `PATH`. `wget` works in place of `curl` throughout.

The script does two things that matter more than they sound:

- the archive is checked against the release's `checksums.txt`, and refuses to install if it does not match
- the new binary is staged, run, and only then moved into place — a bad download fails without costing you the copy you already had

| variable | effect |
| --- | --- |
| `KANEO_VERSION` | install a specific tag instead of the latest release |
| `KANEO_INSTALL_DIR` | install somewhere other than `$HOME/.local/bin` |
| `KANEO_RELEASE_BASE` | fetch archives from a mirror |

```bash
# a specific version, somewhere else
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/kaneo-cli/main/install.sh \
  | KANEO_VERSION=v0.1.0 KANEO_INSTALL_DIR=/usr/local/bin sh
```

Piping a script into a shell is worth being uneasy about. To read it first:

```bash
curl -fsSLO https://raw.githubusercontent.com/TakashiAihara/kaneo-cli/main/install.sh
less install.sh && sh install.sh
```

Or take the archive for your platform straight from the [releases page](https://github.com/TakashiAihara/kaneo-cli/releases) — `linux/amd64`, `linux/arm64`, `darwin/arm64` and `darwin/amd64`, each with a checksum.

Or build from source:

```bash
bun install && bun run build   # archives for every platform in dist/
```

## Configure

Settings resolve from strongest to weakest:

1. command-line flags — `--api-url`, `--api-key`, `--workspace`, `--project`
2. environment — `KANEO_API_URL`, `KANEO_API_KEY`, `KANEO_WORKSPACE`, `KANEO_PROJECT`
3. `.kaneo.json` in the current directory or any parent, up to `$HOME` — workspace and project only
4. the active profile in `~/.config/kaneo/config.json`
5. the `repos` map in that same file, keyed by the git remote's `owner/repo` — project only, and the one layer that can name more than one
6. the `owners` map in that same file, keyed by the remote's owner — workspace only

Not every layer answers every setting:

| setting | comes from |
| --- | --- |
| api url | flag, environment, profile, then the hosted default |
| api key | flag, environment, profile |
| workspace | flag, environment, `.kaneo.json`, profile, `owners` |
| project | flag, environment, `.kaneo.json`, profile, `repos` |

`kaneo context` prints the resolved values and names the layer each one came from.

`kaneo context --repo owner/name` (or a git remote URL) resolves for that repository instead of the one the current directory's remote names, so the maps can be read before a checkout exists.

- The `.kaneo.json` layer is left out entirely, including the ones above the current directory. A checkout of the named repository would still apply them, so the answer can differ from what that checkout resolves to.
- Flags, the environment and the active profile still apply above the maps. `origin.project` is `repo-map` only when `repos` answered.

### Ids, slugs and names

`--project`, `--workspace` and `task move --to` take an id, a slug or a name, matched in that order: an id exactly, a slug or a name exactly before ignoring case. A slug or a name matching exactly one is used; several matches are all listed so the id can pick one.

A project is sent as an id first, so an id costs no extra request; only when the server says it does not know the value is it looked up across every workspace the key can reach (one listing per workspace), which a slug kept in `.kaneo.json` or the repo map pays on every command. A workspace is matched against `workspace ls` before it is sent — one request — because an instance admin's key gets an empty project list, not an error, for a workspace that does not exist. That listing holds only the workspaces the key's user is a member of.

That is what lets the two forms people actually type work: a slug is the prefix of every task reference, and `workspace ls` prints names next to their ids.

### `.kaneo.json`

```json
{
  "workspace": "your-workspace-id",
  "project": "your-project-id"
}
```

The nearest file wins per field, so a parent can supply a workspace while a subdirectory overrides the project. This file is meant to be committed, so it carries no credentials.

### Global config

```json
{
  "default_profile": "self",
  "profiles": {
    "self": { "api_url": "https://kaneo.example.com" }
  },
  "owners": {
    "some-org": "workspace-id-for-that-org"
  },
  "repos": {
    "some-org/some-repo": "project-id",
    "some-org/another-repo": ["project-id", "another-project-id"]
  }
}
```

`owners` states a rule once for a whole organisation: every repository under it belongs to that workspace. It supplies a workspace only — a workspace does not imply a project, so `repos` or `.kaneo.json` still names that.

A `repos` entry takes either one project id or a list of them, because a workspace holds any number of projects and one repository can have work on several. `board` then shows a section per project. Everything else acts on one board, so in a repository mapped to several it asks which: `--project` or `KANEO_PROJECT` names it, and either of those also narrows `board` to that one.

A finished project leaves the board by being archived, not by being edited out of `repos`:

```bash
kaneo project archive <project-id>     # off the board; nothing is deleted
kaneo project unarchive <project-id>   # back again
kaneo project ls --archived            # find one to bring back
kaneo board --archived                 # show them anyway
```

Written with mode `0600`, since a profile may hold a key.

### Self-hosted instances

`--api-url` takes the site root; `/api` is appended for you.

```bash
export KANEO_API_URL=https://kaneo.example.com
export KANEO_API_KEY=...   # Settings -> Account -> Developer
```

## Use

```bash
kaneo context                       # what did the settings resolve to, and from where
kaneo whoami                        # is the key accepted, and what can it reach
kaneo workspace ls
kaneo workspace rename <workspace-id> <name>   # name only; slug and description unchanged
kaneo workspace members         # the resolved workspace's members and their roles
kaneo invitation get <invitation-id>   # whether one can still be accepted, and why not
kaneo search <text...> [--type tasks|projects|workspaces|comments|activities] [--limit N] [--in-project | -A]
                                # the whole resolved workspace unless --in-project or -p narrows it; --limit is at most 50
                                # -A searches every workspace as one ranked list; `search <text> -A --type tasks --limit 50` is the duplicate check before task create
kaneo project ls [-A]           # -A lists every workspace, naming the workspace each project is in
kaneo project find <text>       # substring match on name and slug, across every workspace
kaneo project get [project-id]
kaneo project create <name> [--slug SLUG] [-d TEXT] [--icon ICON]
kaneo project update <project-id> [--name NAME] [--slug SLUG] [-d TEXT] [--icon ICON]   # only what is passed changes
kaneo project reorder <project>...   # the new order: every project not archived in the workspace, exactly once, by id, slug or name
kaneo project rm <project> --yes   # permanent: everything in it goes — tasks, comments, columns, workflow rules, external links
kaneo column ls                    # the resolved project's columns, in board order
kaneo column create <name...> [--final] [--icon ICON] [--color COLOR]
kaneo column rename <column> <new name...>   # the slug, and so every status in it, stays
kaneo column reorder <column>...   # the new order: every column exactly once, by id, slug or name
kaneo column rm <column> --yes
kaneo workflow ls                 # the resolved project's rules, and where each one puts a task
kaneo workflow set <integration> <event> <column>   # one of the pairs listed below; setting a pair again moves the column
kaneo workflow rm <rule-id>       # or <integration> <event>, instead of the id; by id the rule is deleted wherever it is
kaneo task ls [--status ...] [--priority ...] [--all]
kaneo task get <task-id>                 # also lists the task's relations
kaneo task create <title> [-d TEXT | --description-file PATH] [flags]
kaneo task create <title> --attach [--next <step>] [--force]   # attaches this session to the new task; --force creates beside one naming the same reference
kaneo task update <task> [--title TEXT] [-d TEXT | --description-file PATH] [--status COL] [--priority P] [--start-date DATE] [--position N]   # only what is passed changes; --start-date "" clears
kaneo task status <task-id> <status>
kaneo notification ls [--unread]                             # the newest 50, as the server returns
kaneo notification read <notification-id>... | --all
kaneo notification create <message> [--title T] [--type T]   # to yourself
kaneo notification clear --yes                               # deletes every notification
kaneo notification preferences get
kaneo notification preferences set [--email=false] [--ntfy] [--ntfy-topic T] [--reminder-lead 2h] ...   # only what is passed changes
kaneo notification preferences workspace set <workspace-id> [--active=false] [--webhook] [--projects id,id]
kaneo notification preferences workspace rm <workspace-id>   # the workspace is then sent nothing outside the app
kaneo task links <task>
kaneo task external-links <task>   # links to what is outside the board, from an integration or added by hand
kaneo task link <task> <other> --type <type>    # subtask, blocks or related; the type says which way round
kaneo task unlink <relation-id>
kaneo task unlink <task> <other> [--type <type>]
kaneo comment ls <task>
kaneo comment add <task> <text...> | - | -F PATH
kaneo comment edit <task> <comment-id> <text...>   # only the author may edit
kaneo activity ls <task>                            # history: comments and events such as status changes
kaneo activity add <task> <type> [message...] [--data '{"k":"v"}']   # a history entry only; cannot be removed on its own; Kaneo 2.23.0+
kaneo label ls [task]                # the workspace's labels, or those on a task
kaneo label get <label>
kaneo label create <name> [--color COLOR]
kaneo label attach <task> <label>    # a label by name or id
kaneo label detach <task> <label>
kaneo label update <label> [--name NAME] [--color COLOR]   # tasks carrying it follow
kaneo label rm <label> --yes         # also removes it from every task
kaneo time ls <task-id>
kaneo time get <entry-id>
kaneo time add <task-id> [--start TIME] [-d TEXT]               # starts a running timer, now by default (alias: time start)
kaneo time add <task-id> --start TIME --end TIME [-d TEXT]      # logs a finished entry
kaneo time stop <entry-id>                                      # ends a running timer now
kaneo time update <entry-id> [--start TIME] [--end TIME] [-d TEXT]   # only what is passed changes
kaneo task due <task> [date]       # no date clears it
kaneo task bulk <task>... --status done   # one change for many tasks; --help lists the change flags
kaneo task export > tasks.json     # the project's tasks as JSON, labels by name
kaneo task import tasks.json       # creates them in the resolved project; - reads stdin; exits non-zero if any task failed
```

A status is a column slug. The defaults are `to-do`, `in-progress`, `in-review` and `done`, but a project can define more, and `kaneo column ls` is what says which columns it has. The server also takes `planned` and `archived`, which no column holds. `task update` writes the status first, and when a field after it fails the error names the fields that were already updated.

Long text is taken as it was written rather than as a shell passes it: `-` is stdin, `--description-file` and `-F, --file` name a file, and `-d -`, `--description-file -` and `-F -` all read stdin. It is stored byte for byte, trailing newline included, so a heredoc or a note file arrives as it stands — except for a leading BOM, which is dropped as the encoding signature it is. Text that turns out to be nothing but whitespace on the way is refused rather than stored, so clearing a description is `-d ""`.

A project's slug is the prefix of its task identifiers. Without `--slug`, `project create` derives it the way the Kaneo web app does: the first three letters of a one-word name, or the initials of the first three words, upper case, in any script (`Alpha Beta Gamma` → `ABG`, `日本語だけ` → `日本語`). A name with no letter or number derives nothing, and a derived slug another project in the workspace already has is refused; both have to be given `--slug`.

A task in no column at all — the server answers `planned` and `archived` tasks beside the columns — is read as a column of its own, and `task ls` leaves those out unless `--all` or an explicit `--status` asks for them. `board` shows neither.

Times are ISO 8601 with an offset (`2026-01-02T09:00:00Z`, `2026-01-02T18:00+09:00`); a time without one is refused rather than read in some zone. "Now" is this machine's clock.

`task create` reads the board first and refuses a title that names a reference an open task already names — `ccx#165`, `(ccx #165)` and `TakashiAihara/ccx#165` are one reference, while a bare `#165`, `ccx #165` outside parentheses and two different owners are not — and `--force` creates it anyway. A title merely worded like an open one is created, with the tasks it resembles named on stderr. `--attach` and `--next` are about the attachment rather than the task: `--next` without `--attach` is refused rather than dropped, and a `--attach` with no session id is refused before anything is created.

`task status`, `task priority`, `task assign` and `task move` read the task back after the write and print the state the server holds, rather than the value that was sent; a value that came back different fails the command instead of printing as a write that took.

Anywhere a task is taken, either its number or its id works — `kaneo task status 7 done` and `kaneo task status <id> done` do the same thing. `<project>#<number>` names a board and a number on it: `kaneo task get kaneo-cli#3` reads the reference written as `kaneo kaneo-cli#3`, which is also what `KANEO_TASK_REF` holds after its `kaneo ` prefix. The project before the `#` is an id, slug or name.

`task link` will not guess the type: a link written with one nobody asked for has to be undone before the right one can be written. `task unlink` takes two tasks and removes the one link joining them in either direction, or one relation id from `task links --json`.

`--timeout` bounds one request, not the command: every page of a board gets the whole of it, so a board's size does not decide whether it can be read. Nothing bounds the command as a whole. A timeout of zero or less is not the default and not no timeout: every request fails at once.

A workflow rule moves a task with nobody at the board: `kaneo workflow set github pr_opened in-review` says that a task whose pull request was opened lands in that column. The integration and the event are Kaneo's own names, the ones its plugins fire, and not the provider's webhook names: an integration of `github`, `gitea` or `gitlab`, and an event of `branch_push`, `pr_opened`, `pr_merged`, `issue_opened`, `issue_closed` or `issue_reopened`. Anything else is stored as written and warned about on stderr, since no plugin fires it. The server's upsert looks for a rule the project already has for the pair and moves its column, so setting a pair again moves the rule already there rather than adding a second one — though nothing on the server keeps it to one, and `workflow rm` refuses a pair it finds twice rather than delete one of the two. `kaneo workflow rm` deletes a rule by its id, wherever it is, or by the integration and event it names in the resolved project.

`kaneo task external-links <task>` lists what a task points at outside the board: the links an integration brought in — an issue, a pull request — and the ones somebody added by hand. A link that came through an integration is marked with the integration it came through, since the same URL can be either.

### Shell completion

```bash
kaneo completion zsh > "${fpath[1]}/_kaneo"    # or bash, fish, powershell
```

Each sub-command writes the script for its shell and says where to put it. `--no-descriptions` leaves the descriptions out, which is what a shell that shows only the candidates wants.

### Agent sessions

Tasks carry no custom fields, so the link between a session and a task is written into a task comment:

```bash
kaneo session attach 7 "what happens next"
kaneo session next "what happens after that"
kaneo session close
kaneo board                     # open tasks, and which sessions hold them
```

The session is identified by `KANEO_SESSION_ID`, falling back to `CLAUDE_CODE_SESSION_ID`.

`kaneo session close [--task <task>]` acts on the task in the attachment, the one last attached; `--task` names another one, as `slug#number` (the form `session status` prints), a number in the current project, or an id, so a session that has attached to several tasks releases only the one named. The attachment is only removed when it is that task, and a task can be closed by name with no attachment at all — a session that attached, re-attached elsewhere and then wants the first one released.

What a session holds is kept in `~/.config/kaneo/sessions/<session id>.json`, and every attach and close is appended to `<session id>.history.jsonl` beside it, one JSON line each, holding the time, the task and the board it was on. Close removes the attachment — other tools read that file as "currently attached" — and keeps the history, so a check running after the session has ended can still see what it did. `kaneo session status` prints the attachment and the history, reading only those files: no request is made and no key is needed.

The `session` commands are **fail-open**, `session status` excepted: it makes no request, so there is nothing for fail-open to swallow, and a session id nobody set is worth reporting. An unreachable server, a missing key or an unconfigured project makes the others print nothing and exit 0, so a session-start hook is not broken by any of them. `--strict` turns that off and `KANEO_DEBUG=1` prints the reason that was swallowed. `board` is not: it fails like any other command, so an empty board and one that could not be read look different.

A failure that already changed something elsewhere is reported regardless — `session attach` that wrote the comment but could not record it locally, for instance. Staying quiet there would leave `session next` believing nothing is attached.

`session close` on a held task the server can no longer place (deleted, or out of the key's reach) releases the attachment anyway, runs the close hook, and exits 1 saying that no close marker was written. Any other failure of the marker keeps the attachment, so the close can be run again.

Each of attach, next and close posts its marker and then confirms the server kept it, since a marker nobody can read would leave `session next` posting onto a board this session is not on. A marker the server took and did not keep is reported, naming `kaneo comment ls <task>` to look at before retrying — a blind retry posts a second marker. `session close` confirms last, after the attachment is cleared and the history written, so a close whose marker was lost is posted again with `session close --task <N>`; a listing that cannot be read is fail-open for next and close and fails attach.

#### Hooks

`hooks` in the global config runs a shell command after `session attach` or `session close` succeeds, so another tool can follow the session without either knowing about the other:

```json
{
  "hooks": {
    "attach": "ccx session task \"$KANEO_TASK_REF\" \"$KANEO_SESSION_ID\"",
    "close": "ccx session task \"\" \"$KANEO_SESSION_ID\""
  }
}
```

The command runs under `sh -c` with `KANEO_HOOK_EVENT`, `KANEO_SESSION_ID`, `KANEO_TASK_ID`, `KANEO_TASK_NUMBER` and `KANEO_TASK_REF` (`kaneo <project slug>#<number>`, set on attach only, empty when the slug could not be looked up). A hook that fails does not fail the command: the reason goes to stderr and is appended to `hooks.log` next to the config (`$XDG_CONFIG_HOME/kaneo/`, by default `~/.config/kaneo/`). A hook still running after 10 seconds is killed along with its process group, and that counts as a failure.

## Output

Human-readable on a terminal, JSON through a pipe:

```bash
kaneo task ls              # a table
kaneo task ls | jq '.[0]'  # JSON, no flag needed
kaneo task ls --json       # JSON on a terminal too
kaneo task ls --human      # a table through a pipe
```

Data goes to stdout and progress goes to stderr, so piping into `jq` is always safe.

`--jq <expression>` narrows the JSON to what a caller wants, so reading one field is one command instead of a pipe into `jq`:

```bash
kaneo task create "fix the parser" --jq .number   # 4
kaneo task get 1 --jq .status                    # to-do
```

jq runs inside the binary, so nothing has to be installed. Output follows `gh --jq` to a pipe: each value ends with a newline, strings print raw and everything else as compact JSON. `--jq` implies `--json` and wins over `--human`.

In JSON mode (`--json`, or stdout not a terminal) a failure exits 1 and puts `{"error": ...}` on stdout, unless the command has already printed its payload: `api-check` and `task import` print their report and then exit 1, and the report stays the only document on stdout, with the error on stderr. Until 0.2.1-rc.38 the `{"error": ...}` object followed the report as a second document.

With `--jq`, a failure exits 1 and stdout holds only what the expression made of a payload that was printed, which is nothing unless the command had one:

- an expression jq cannot compile is refused before any request is made
- an expression that fails on the payload reports jq's message on stderr, followed by a line saying the command had already run — `task create … --jq` that exits 1 this way has still created the task, so do not retry it blindly
- a failing command reports its error on stderr only; the `{"error": ...}` object `--json` prints is left out
- `api-check` and `task import` are the exceptions: the report is the output, so a failed check, or an import where any task failed, still prints the report (and what the expression makes of it) before exiting 1

## Develop

```bash
bun install
bun test              # unit tests and the parity suite
bun run typecheck
bun run knip          # unused exports, files and dependencies
bun run generate      # regenerate the API client from the pinned document
bun run build         # build every release archive into dist/, as the release job does
bun src/index.ts ...  # run the CLI from source
```

The API client in `src/api/gen` is generated by [Orval](https://orval.dev) from the OpenAPI document shipped in a Kaneo release (pinned in `openapi/spec.ts`; `bun run spec <version>` moves it), restricted to the operations in `src/api/registry.ts` by `openapi/transformer.ts`, which also corrects the places where that document is wrong; each correction says when it can go. CI fails when the pinned document differs from the one the release shipped (`bun run spec --check`) or the generated code does not match it. To call a new endpoint, add its `operationId` to the registry, then `bun run generate`.

`tests/parity/` holds the CLI's observable behaviour: scenarios run against an in-memory Kaneo, compared with recorded outputs. They started as the behaviour of the Go build this CLI replaced; scenarios added since were recorded from this tree. A change that alters any command's output, exit code, requests or files fails there. If the change is intended, record the affected goldens again from this source tree and say why in the commit:

```bash
bun run parity:record              # rewrites only the goldens this tree no longer matches, and writes new ones
git diff --stat tests/parity/golden/
```

Without an argument:

- it runs `src/index.ts` with the same `bun`, so the scenarios that point `PATH` at nothing still start
- it leaves alone every golden the suite already accepts; request bodies are compared as JSON values, so key order is not part of the contract
- it refuses to write a golden that still holds the recording machine's host name, since the goldens are published

Other ways to run it:

- `bun run parity:record --bin <kaneo>` rewrites every golden from that binary instead
- `KANEO_PARITY_BIN=<kaneo> bun test tests/parity` runs the suite against another build, such as the last release, to see what an unreleased change moved
- the suite fails on a golden that no scenario records

Every push to `main` that passes CI is released as the next release candidate (`v0.2.0` → `v0.2.1-rc.1` → `v0.2.1-rc.2`), so the latest release and `install.sh` follow the newest commit on `main` that passed CI. A final version is cut by pushing its tag by hand, or by running the release workflow with that tag.

`kaneo api-check` compares the operations this client calls against the server's OpenAPI document and exits non-zero if the server is missing one, so it works as a CI gate against a specific deployment. It also compares the request side of each operation (query and header parameters and top-level body fields, with whether each is required) with the pinned document's, kept in `src/api/gen/requests.json` by `bun run generate`, and lists as `DRIFT` a field the server's document lacks, or one it requires that the pinned document leaves optional or does not have. Drift does not change the exit status: the pinned document is not exactly what the CLI sends, so each one is a lead to check. Servers before Kaneo 2.26 show some.

## Glossary

`docs/glossary.md` covers the vocabulary, including where this CLI's names differ from the API's — task number against id, status against column, and what a session marker is.

## License

MIT
