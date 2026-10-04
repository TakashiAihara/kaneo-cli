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
kaneo project ls
kaneo project get [project-id]
kaneo project update <project-id> [--name NAME] [--slug SLUG] [-d TEXT] [--icon ICON]   # only what is passed changes
kaneo task ls [--status ...] [--priority ...] [--all]
kaneo task get <task-id>
kaneo task status <task-id> <status>
kaneo notification ls [--unread]                             # the newest 50, as the server returns
kaneo notification read <notification-id>... | --all
kaneo notification create <message> [--title T] [--type T]   # to yourself
kaneo notification clear --yes                               # deletes every notification
kaneo notification preferences get
kaneo notification preferences set [--email=false] [--ntfy] [--ntfy-topic T] [--reminder-lead 2h] ...   # only what is passed changes
kaneo notification preferences workspace set <workspace-id> [--active=false] [--webhook] [--projects id,id]
kaneo notification preferences workspace rm <workspace-id>   # the workspace is then sent nothing outside the app
```

A status is a column id. The defaults are `to-do`, `in-progress`, `in-review` and `done`.

Anywhere a task is taken, either its number or its id works — `kaneo task status 7 done` and `kaneo task status <id> done` do the same thing.

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

The `session` commands are **fail-open**: an unreachable server, a missing key or an unconfigured project makes them print nothing and exit 0, so a session-start hook is not broken by any of them. `--strict` turns that off and `KANEO_DEBUG=1` prints the reason that was swallowed. `board` is not: it fails like any other command, so an empty board and one that could not be read look different.

A failure that already changed something elsewhere is reported regardless — `session attach` that wrote the comment but could not record it locally, for instance. Staying quiet there would leave `session next` believing nothing is attached.

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

## Develop

```bash
bun install
bun test              # unit tests and the parity suite
bun run typecheck
bun run generate      # regenerate the API client from the pinned document
bun run build         # build every release archive into dist/, as the release job does
bun src/index.ts ...  # run the CLI from source
```

The API client in `src/api/gen` is generated by [Orval](https://orval.dev) from the OpenAPI document shipped in a Kaneo release (pinned in `openapi/spec.ts`; `bun run spec <version>` moves it), restricted to the operations in `src/api/registry.ts` by `openapi/transformer.ts`, which also corrects the places where that document is wrong; each correction says when it can go. CI fails when the generated code does not match the pinned document. To call a new endpoint, add its `operationId` to the registry, then `bun run generate`.

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

`kaneo api-check` compares the operations this client calls against the server's OpenAPI document and exits non-zero if the server is missing one, so it works as a CI gate against a specific deployment.

## Glossary

`docs/glossary.md` covers the vocabulary, including where this CLI's names differ from the API's — task number against id, status against column, and what a session marker is.

## License

MIT
