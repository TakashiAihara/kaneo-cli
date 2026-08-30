# kaneo

Command-line client for [Kaneo](https://github.com/usekaneo/kaneo), the self-hostable project management tool.

Single static binary, no runtime to install. Ships for `linux/amd64`, `linux/arm64`, `darwin/arm64` and `darwin/amd64`.

## Status

Early. The command surface below is what exists today; the rest of the API is not wired up yet.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/kaneo-cli/main/install.sh | sh
```

Installs into `$HOME/.local/bin`. The script verifies the archive against the release's `checksums.txt` and runs the installed binary before reporting success, so a partial install fails rather than looking like it worked.

| variable | effect |
| --- | --- |
| `KANEO_VERSION` | install a specific tag instead of the latest release |
| `KANEO_INSTALL_DIR` | install somewhere other than `$HOME/.local/bin` |
| `KANEO_RELEASE_BASE` | fetch archives from a mirror |

Or build from source:

```bash
make build
```

## Configure

Settings resolve from strongest to weakest:

1. command-line flags — `--api-url`, `--api-key`, `--workspace`, `--project`
2. environment — `KANEO_API_URL`, `KANEO_API_KEY`, `KANEO_WORKSPACE`, `KANEO_PROJECT`
3. `.kaneo.json` in the current directory or any parent, up to `$HOME` — workspace and project only
4. the active profile in `~/.config/kaneo/config.json`
5. the `repos` map in that same file, keyed by the git remote's `owner/repo` — project only
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
    "some-org/some-repo": "project-id"
  }
}
```

`owners` states a rule once for a whole organisation: every repository under it belongs to that workspace. It supplies a workspace only — a workspace does not imply a project, so `repos` or `.kaneo.json` still names that.

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
kaneo project ls
kaneo project get [project-id]
kaneo task ls [--status ...] [--priority ...] [--all]
kaneo task get <task-id>
kaneo task status <task-id> <status>
```

A status is a column id. The defaults are `to-do`, `in-progress`, `in-review` and `done`.

Anywhere a task is taken, either its number or its id works — `kaneo task status 7 done` and `kaneo task status <id> done` do the same thing.

### Agent sessions

Tasks carry no custom fields, so the link between a session and a task is written into a task comment:

```bash
kaneo session attach 7 "what happens next"
kaneo session next "what happens after that"
kaneo session close
kaneo board                     # open tasks, and which sessions hold them
```

The session is identified by `KANEO_SESSION_ID`, falling back to `CLAUDE_CODE_SESSION_ID`.

`board` and the `session` commands are **fail-open**: an unreachable server, a missing key or an unconfigured project makes them print nothing and exit 0, so a session-start hook is not broken by any of them. `--strict` turns that off and `KANEO_DEBUG=1` prints the reason that was swallowed.

A failure that already changed something elsewhere is reported regardless — `session attach` that wrote the comment but could not record it locally, for instance. Staying quiet there would leave `session next` believing nothing is attached.

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
make check      # go vet + go test
make cross      # build every release target into dist/
make snapshot   # build the release archives exactly as the release job does
```

`kaneo api-check` compares the operations this client calls against the server's OpenAPI document and exits non-zero if the server is missing one, so it works as a CI gate against a specific deployment.

## Glossary

`docs/glossary.md` covers the vocabulary, including where this CLI's names differ from the API's — task number against id, status against column, and what a session marker is.

## License

MIT
