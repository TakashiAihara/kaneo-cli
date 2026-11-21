# kaneo

Command-line client for [Kaneo](https://github.com/usekaneo/kaneo), the self-hostable project management tool.

Human-readable on a terminal and JSON through a pipe, so scripts and coding agents read the same commands people type (see [Output](#output)). An agent session can attach itself to the task it is working on and leave its next step there (see [Agent sessions](#agent-sessions)).

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
| api key | flag, environment, profile, profile's `api_key_command` |
| workspace | flag, environment, `.kaneo.json`, profile, `owners` |
| project | flag, environment, `.kaneo.json`, profile, `repos` |

`kaneo context` prints the resolved values and names the layer each one came from.

`kaneo context --repo owner/name` (or a git remote URL) resolves for that repository instead of the one the current directory's remote names, so the maps can be read before a checkout exists.

- The `.kaneo.json` layer is left out entirely, including the ones above the current directory. A checkout of the named repository would still apply them, so the answer can differ from what that checkout resolves to.
- Flags, the environment and the active profile still apply above the maps. `origin.project` is `repo-map` only when `repos` answered.

### Ids, slugs and names

`--project`, `--workspace` and `task move --to` take an id, a slug or a name (`task move --to` matches only the projects of the task's own workspace, as the server moves a task nowhere else), matched in that order: an id exactly, a slug or a name exactly before ignoring case. A slug or a name matching exactly one is used; several matches are all listed so the id can pick one.

A project is sent as an id first, so an id costs no extra request; only when the server says it does not know the value is it looked up across every workspace the key can reach (one listing per workspace, all asked at once), which a slug kept in `.kaneo.json` or the repo map pays on every command. A workspace whose listing fails does not stop the others: `project ls -A` and `project find` print what was listed, say on stderr which workspace could not be listed and exit 1; a lookup that misses, or that matches only by slug or name, while a workspace is unlisted says so and asks for the id instead of acting on a match that may not be the only one. A workspace is matched against `workspace ls` before it is sent — one request — because an instance admin's key gets an empty project list, not an error, for a workspace that does not exist. That listing holds only the workspaces the key's user is a member of.

That is what lets the two forms people actually type work: a slug is the prefix of every task reference, and `workspace ls` prints names next to their ids, followed by each workspace's description where it has one.

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

A profile can name a command that prints the key instead of holding it, so the key stays in a secret manager and reaches only this process:

```json
{ "profiles": { "self": { "api_key_command": "pass show kaneo/api-key | head -n1" } } }
```

The command runs through `sh -c` only when `--api-key`, `KANEO_API_KEY` and the profile's `api_key` are all empty and a request is about to be sent (`completion`, `session status` and `context` never run it; `context` reports such a key as `set (command)` without checking that the command works), at most once per run and for up to 30 seconds. Its stdout, trimmed, is the key; its stderr is shown as is, so it must not print the key there. A non-zero exit, empty output, 64 KiB or more, or anything but printable ASCII without spaces stops the command that needed the key without printing the value; a fail-open `session` command still exits 0. `kaneo context` reports the key's origin as `command`. This makes the config file run code on routine commands, so do not sync it from anywhere you would not run a script from.

### Self-hosted instances

`--api-url` takes the site root; `/api` is appended for you.

```bash
export KANEO_API_URL=https://kaneo.example.com
export KANEO_API_KEY=...   # Settings -> Account -> Developer
```

## Use

```bash
kaneo context                       # what did the settings resolve to, and from where
kaneo whoami                        # is the key accepted, whose is it, and what can it reach
kaneo workspace ls
kaneo workspace rename <workspace-id> <name>   # name only; slug and description unchanged
kaneo workspace members         # the resolved workspace's members and their roles
kaneo invitation get <invitation-id>   # whether one can still be accepted, and why not
kaneo search <text...> [--type tasks|projects|workspaces|comments|activities] [--limit N] [--in-project | -A]
                                # the whole resolved workspace unless --in-project or -p narrows it; --limit is at most 50
                                # -A searches every workspace as one ranked list; `search <text> -A --type tasks --limit 50` is the duplicate check before task create
kaneo project ls [-A]           # each line carries the [slug] that -p takes; -A lists every workspace, naming each one, and cannot be combined with -w
kaneo project find <text>       # substring match on name and slug, across every workspace
kaneo project get [project-id]
kaneo project create <name> [--slug SLUG] [-d TEXT] [--icon ICON]
kaneo project create --name <name> [flags]                     # the same, as project update takes the name; not both
kaneo project update <project-id> [--name NAME] [--slug SLUG] [-d TEXT] [--icon ICON]   # only what is passed changes; --json adds "unread", the fields the read lacked (their "from" is "")
kaneo project reorder <project>...   # the new order: every project not archived in the workspace, exactly once, by id, slug or name
kaneo project rm <project> --yes   # permanent: everything in it goes — tasks, comments, columns, workflow rules, external links
kaneo project move <project> --to <workspace>   # to another workspace, named by id, slug or name; tasks follow, and an assignee who is no member there is unassigned
kaneo project background get [project]          # the board background image, written to stdout as it arrives — redirect it to a file
kaneo project background set <project> <file>   # `-` reads stdin; the content type comes from --content-type or the file's extension
kaneo project background rm <project> --yes     # alias: delete
kaneo column ls                    # the resolved project's columns, in board order
kaneo column create <name...> [--final] [--icon ICON] [--color COLOR]
kaneo column rename <column> <new name...>   # the slug, and so every status in it, stays
kaneo column reorder <column>...   # the new order: every column exactly once, by id, slug or name
kaneo column rm <column> --yes
kaneo field ls                     # the resolved project's custom fields, in order
kaneo field add <name...> --type <type> [--required] [--default VALUE] [--options a,b,c]
kaneo field values [field]         # every value tasks hold, or the distinct values one field takes
kaneo field reorder <field>...     # the new order: every field exactly once, by id or name
kaneo field rm <field> --yes       # also deletes the values tasks hold for it
kaneo workflow ls                 # the resolved project's rules, and where each one puts a task
kaneo workflow set <integration> <event> <column>   # one of the pairs listed below; setting a pair again moves the column
kaneo workflow rm <rule-id>       # or <integration> <event>, instead of the id; by id the rule is deleted wherever it is
kaneo integration gitea get                 # the resolved project's Gitea link, or that there is none
kaneo integration gitea connect <owner>/<name> --base-url <url> [--token -]
kaneo integration gitea update [--active=false] [--comment-task-link=false]
kaneo integration gitea rm --yes
kaneo integration gitea verify <owner>/<name> --base-url <url> [--token -]   # checks without linking
kaneo integration gitea repos --base-url <url> --token -                     # the repositories the token can reach
kaneo integration gitea import               # the linked repository's open issues as tasks
kaneo integration gitlab get      # the project's stored link, or that there is none
kaneo integration gitlab connect --base-url URL --project-path PATH [--access-token -] [--token-type private|bearer]
kaneo integration gitlab update [--active=false] [--comment-task-link=false]   # only what is passed changes
kaneo integration gitlab rm --yes   # also: delete; removes the link and its stored secrets
kaneo integration gitlab verify --base-url URL --project-path PATH --access-token -   # checks the token reaches the project, stores nothing; the check's findings are data, not an error
kaneo integration gitlab projects --base-url URL --access-token -   # the GitLab projects the token can see, to pick one
kaneo integration gitlab import   # the linked project's open issues as tasks; exits non-zero when any issue failed
kaneo integration slack get                    # also discord and telegram: the chat integrations a project's events post out to
kaneo integration slack set --webhook-url - [--channel-name NAME] < webhook-url.txt
kaneo integration telegram set --bot-token - --chat-id <chat-id> [--thread-id N] [--chat-label NAME] < token.txt
kaneo integration slack rm --yes
kaneo task ls [--status ...] [--priority ...] [--description TEXT] [--all]
kaneo task ls --mine       # open tasks assigned to you across the workspace, at most 100
kaneo task get <task-id>                 # also lists the task's relations and the sessions holding it
kaneo task describe <task>               # the description in full, however long
kaneo task create <title> [-d TEXT | --description-file PATH] [flags]
kaneo task create --title <title> [flags]                      # the same, as task update takes the title; not both
kaneo task create <title> --attach [--next <step>] [--force]   # attaches this session to the new task; --force creates beside one naming the same reference
kaneo task update <task> [--title TEXT] [-d TEXT | --description-file PATH] [--status COL] [--priority P] [--assignee USER] [--start-date DATE] [--position N]   # only what is passed changes; --start-date "" clears
kaneo task duplicate <task> [--title T] [--to PROJECT]         # a copy of the task; --to moves the copy to another project
kaneo task status <task-id> <status>
kaneo notification ls [--unread]                             # the newest 50, as the server returns
kaneo notification read <notification-id>... | --all
kaneo notification create <message> [--title T] [--type T]   # to yourself
kaneo notification clear --yes                               # deletes every notification
kaneo notification preferences get
kaneo notification preferences set [--email=false] [--ntfy] [--ntfy-topic T] [--reminder-lead 2h] ...   # only what is passed changes
kaneo notification preferences set --ntfy-token - < token.txt   # also --gotify-token - and --webhook-secret -; one per command; one trailing line ending is dropped; empty stdin is an error (clear with ''); a secret that is exactly - cannot be passed as a value
kaneo notification preferences workspace set <workspace-id> [--active=false] [--webhook] [--projects id,id]
kaneo notification preferences workspace rm <workspace-id>   # the workspace is then sent nothing outside the app
kaneo integration mattermost get
kaneo integration mattermost set [flags]   # creates the project's Mattermost integration when it has none, changes it otherwise; only the flags passed are sent
kaneo integration mattermost rm --yes
kaneo integration webhook get
kaneo integration webhook set [flags]   # the same shape; --help lists its event toggles and --reminder-lead
kaneo integration webhook rm --yes
kaneo task links <task>
kaneo task external-links <task> [--add URL] [--title T] [--rm ID]   # links to what is outside the board, from an integration or added by hand
kaneo task field <task> [<name> <value...>]   # the values the task holds, or set one; the words make the value
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
kaneo label create --name <name> [--color COLOR]               # the same, as label update takes the name; not both
kaneo label attach <task> <label>    # a label by name or id
kaneo label detach <task> <label>
kaneo label update <label> [--name NAME] [--color COLOR]   # tasks carrying it follow
kaneo label rm <label> --yes         # also removes it from every task
kaneo feed ls                        # the resolved project's calendar feeds, with subscribe links
kaneo feed create <label>... [--time-zone ZONE]
kaneo feed rm <feed> --yes           # the subscribe link stops working for good
kaneo feed get <token>               # the feed's iCalendar document, as a calendar app reads it
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
kaneo task upload <task> <file> [--surface description|comment]   # stores an image; prints the asset URL a description or comment embeds
kaneo integration github app-info                    # the GitHub App this instance is configured with
kaneo integration github repos [--installation-page N] [--repository-page N]
kaneo integration github verify <owner> <repo>       # the App's installation and permissions on a repository, as data
kaneo integration github get                         # the project's GitHub integration, or none
kaneo integration github connect <owner> <repo>      # link the project to a repository the App reaches
kaneo integration github update [--active=false] [--comment-task-link=false]   # only what is passed changes
kaneo integration github rm --yes                    # unlink the project from its repository
kaneo integration github import [--run-id ID]        # import the repository's issues as tasks, resuming until done
kaneo instance status              # whether the instance has users and an admin yet; no key needed
kaneo instance config              # the public configuration: sign-in methods, features, limits; no key needed
kaneo whoami session               # the session the credential resolves to; the session token is never shown
kaneo whoami avatar set <file>     # upload a .png, .jpg, .jpeg or .webp as your avatar (at most ~512 KiB)
kaneo whoami avatar rm             # remove your avatar; removing none still succeeds
kaneo public project <project-id> [--status S] [--priority P] [--assignee-id ID] [--sort-by F] [--sort-order asc|desc] [--due-before T] [--due-after T] [--limit N]
                                # the board a public link shares, by project id; no key needed
kaneo public description <project-id> [task]   # a public project's description, or one task's by id or board number; no key needed
kaneo asset get <asset-id> [--out <file>]      # an asset's bytes; a private project's asset needs the key
kaneo avatar get <avatar-id> [--out <file>]    # a user's avatar image by the id in its URL; no key needed
```

A status is a column slug. The defaults are `to-do`, `in-progress`, `in-review` and `done`, but a project can define more, and `kaneo column ls` is what says which columns it has. The server also takes `planned` and `archived`, which no column holds. `task update` writes the status first, and when a field after it fails the error names the fields that were already updated.

Long text is taken as it was written rather than as a shell passes it: `-` is stdin, `--description-file` and `-F, --file` name a file, and `-d -`, `--description-file -` and `-F -` all read stdin. It is stored byte for byte, trailing newline included, so a heredoc or a note file arrives as it stands — except for a leading BOM, which is dropped as the encoding signature it is. Text that turns out to be nothing but whitespace on the way is refused rather than stored, so clearing a description is `-d ""`.

A project's slug is the prefix of its task identifiers. Without `--slug`, `project create` derives it the way the Kaneo web app does: the first three letters of a one-word name, or the initials of the first three words, upper case, in any script (`Alpha Beta Gamma` → `ABG`, `日本語だけ` → `日本語`). A name with no letter or number derives nothing, and a derived slug another project in the workspace already has is refused; both have to be given `--slug`.

`project move` takes a project to another workspace: `--to` is a workspace id, slug or name matched the way `--workspace` is, resolved before the project is even tried. The project keeps its id and moves with its tasks; the server refuses the move when the destination already has a project with the same key or a task in it relates to a task in another project, and it unassigns the tasks whose assignee is not a member of the destination — the count is in the reply. The project is named the way `project rm` names it: required rather than resolved from the settings, since a move typed inside a checkout would otherwise hit whichever project that repo maps to.

A project's board background is an image the `background` group manages. `background set` uploads `file` (`-` reads the bytes from stdin, which then needs `--content-type`) through the presigned URL the API prepares, the way the web app's upload runs; the content type comes from `--content-type` or the file's extension, and the server accepts only the image types it lists, up to its size limit. `background get` writes the image to stdout exactly as it arrives — it is not JSON, so `--json` and `--jq` are refused, and so is a terminal, since the bytes are the server's to choose; redirect it to a file (`> bg.png`) or pipe it on. `background rm` needs `--yes`, as every delete does.

A task in no column at all — the server answers `planned` and `archived` tasks beside the columns — is read as a column of its own. `task ls` leaves out tasks in `done`, `planned` and `archived` unless `--all` or an explicit `--status` asks for them, and says on stderr, in every output mode, how many it left out. `board` shows neither planned nor archived tasks.

Times are ISO 8601 with an offset (`2026-01-02T09:00:00Z`, `2026-01-02T18:00+09:00`); a time without one is refused rather than read in some zone. "Now" is this machine's clock.

`task create` reads the board first and refuses a title that names a reference an open task already names — `ccx#165`, `(ccx #165)` and `TakashiAihara/ccx#165` are one reference, while a bare `#165`, `ccx #165` outside parentheses and two different owners are not — and `--force` creates it anyway. A title merely worded like an open one is created, with the tasks it resembles named on stderr. `--attach` and `--next` are about the attachment rather than the task: `--next` without `--attach` is refused rather than dropped, and a `--attach` with no session id is refused before anything is created.

`task status`, `task priority`, `task assign` and `task move` read the task back after the write and print the state the server holds, rather than the value that was sent; a value that came back different fails the command instead of printing as a write that took.

Anywhere a task is taken, either its number or its id works — `kaneo task status 7 done` and `kaneo task status <id> done` do the same thing. `<project>#<number>` names a board and a number on it: `kaneo task get kaneo-cli#3` reads the reference written as `kaneo kaneo-cli#3`, which is also what `KANEO_TASK_REF` holds after its `kaneo ` prefix. The project before the `#` is an id, slug or name. `<slug>-<number>` (`kaneo task get BET-1`) is the form the Kaneo server and UI write a task as: the server resolves it in one request, the last dash splits it (so `kaneo-cli-3` is slug `kaneo-cli`), and the slug is matched ignoring case. Its errors are shown as the server wrote them, including a 409 when the slug names more than one project. It needs Kaneo v2.30.0 or later; an older server answers 404.

`task link` will not guess the type: a link written with one nobody asked for has to be undone before the right one can be written. `task unlink` takes two tasks and removes the one link joining them in either direction, or one relation id from `task links --json`.

`--timeout` bounds one request, not the command: every page of a board gets the whole of it, so a board's size does not decide whether it can be read. Nothing bounds the command as a whole. A timeout of zero or less is not the default and not no timeout: every request fails at once.

A request the API key's rate limiter refuses (429 `RATE_LIMITED`, which the server answers on `/api/auth/*`) is sent again after the wait the server names, with a line on stderr, up to three times and 60 seconds of waiting in all — the window Kaneo gives new keys. The fail-open `session` commands do not wait unless `--strict` is given. Kaneo's other routes answer an exhausted key with 401 instead, which cannot be told from a bad key and is not retried.

A workflow rule moves a task with nobody at the board: `kaneo workflow set github pr_opened in-review` says that a task whose pull request was opened lands in that column. The integration and the event are Kaneo's own names, the ones its plugins fire, and not the provider's webhook names: an integration of `github`, `gitea` or `gitlab`, and an event of `branch_push`, `pr_opened`, `pr_merged`, `issue_opened`, `issue_closed` or `issue_reopened`. Anything else is stored as written and warned about on stderr, since no plugin fires it. The server's upsert looks for a rule the project already has for the pair and moves its column, so setting a pair again moves the rule already there rather than adding a second one — though nothing on the server keeps it to one, and `workflow rm` refuses a pair it finds twice rather than delete one of the two. `kaneo workflow rm` deletes a rule by its id, wherever it is, or by the integration and event it names in the resolved project.

`kaneo integration gitea` links the resolved project to a repository on a Gitea instance. `connect` takes the repository as `<owner>/<name>` and the instance as `--base-url`; the server checks the token reaches the repository before storing the link, and the answer carries the webhook URL Gitea should post events to plus its secret when the key may see it. A Gitea access token is a credential, so it is never a flag value: `--token -` reads it from stdin, less the one line ending the pipe adds (`echo "$TOKEN" | kaneo integration gitea connect owner/repo --base-url https://gitea.example.com --token -`). `verify` runs the same checks without storing anything, `repos` lists what the token can reach for picking one, `update` changes only `--active` and `--comment-task-link`, `rm --yes` unlinks, and `import` brings the linked repository's open issues in as tasks — an issue that already has a task is refreshed rather than duplicated. `connect` and `verify` may leave `--token` out when the project already has an integration on the same instance, and the server then uses the stored token; a token is never sent to a different base URL, so moving the link means connecting again with a token.

`kaneo task external-links <task>` lists what a task points at outside the board: the links an integration brought in — an issue, a pull request — and the ones somebody added by hand. A link that came through an integration is marked with the integration it came through, since the same URL can be either. `--add` puts a link on by hand, `--title` names it (only with `--add`), and `--rm` takes one off by the id the `--json` listing prints; the two cannot be passed together, the URL must be http or https, and the server removes only links added by hand — one an integration brought in answers 404.

`task describe` prints a task's description in full. The listing carries a description only up to 64 KiB and marks a longer one deferred, so `task get` reads those through the task detail; `task describe` reads any description through the route that pages large ones, which is the way to see a deferred one without the rest of the task. `task ls --description TEXT` filters on description text case-insensitively, asking the server about the deferred ones and matching the rest locally; the query is at most 256 characters and cannot be combined with `--mine`.

`task duplicate` copies a task inside its project: the copy keeps the source's column, priority, assignee, dates, labels and description, but not its comments, time entries or subtasks. `--title` gives the copy a different title and `--to` moves it to another project afterwards — the destination is resolved before the copy is made, must be in the task's own workspace as the server moves a task nowhere else, and a move that fails leaves the copy where it was, which the error says.

`task upload` stores an image a task's description or a comment can embed: the file is staged, PUT to the storage the server presigns and finalized, and the answer is the asset's URL. `--surface` says where the image will be used (`description` by default, `comment` for one a comment embeds) and chooses the folder its object key is issued under. The image is stored and nothing is written into the task; embedding the URL is the caller's step.

A custom field is a definition a project carries — a text, number, date, dropdown, boolean or multiselect — that its tasks can hold a value for. `kaneo field ls` lists the resolved project's fields in order and `kaneo field add` makes one; a choice field takes `--options`, a required one takes `--default`, and the server checks the rest of the combination. Fields are named by id or name wherever one is taken, and a name two fields share is refused rather than guessed. `kaneo field values` lists every value the project's tasks hold, or with a field the distinct values it actually takes — what a filter on it can offer. `kaneo task field <task>` reads what one task holds and `kaneo task field <task> <name> <value>` sets it, in the task's own project; the words after the name make the value, so a text value with spaces needs no quoting, and a multiselect value is a JSON array of the field's options, as the web app writes it. `kaneo field reorder` and `kaneo field rm` manage the definitions; a delete takes the values tasks hold for the field with it, which is why it asks for `--yes`.

`kaneo integration gitlab` works the link between a project and a GitLab project. `connect` stores it — the instance's root URL, the project's full path (`group/sub/project`), and the token — and answers the webhook URL and secret to give GitLab afterwards; connecting again keeps the stored token while the GitLab URL is unchanged and asks for a new one when it is not. `verify` runs the same checks without storing anything and answers its findings as data rather than an error — a failed check still exits 0, and only a refused request fails the command — `projects` lists what a token can see to pick the project, `update` changes only the flags passed, `import` brings the linked project's open issues in as tasks, and `rm --yes` removes the link.

The GitLab token is a secret, so `--access-token` takes only `-`, which reads it from stdin: a literal value is refused rather than written into the process list or the shell history. One trailing line ending is dropped and empty stdin is an error. `connect` may omit the token for the reuse above. The stored token is only ever answered masked, and the webhook secret only to a caller that may manage the workspace's settings — a plain member reads the link with both withheld, is refused `connect`, `update`, `rm`, `verify` and `projects`, and can still `import`, which asks for task permissions instead.

`kaneo integration github` works with the GitHub integration a project can have. `app-info` says which GitHub App the instance is configured with and whether the key's user has a GitHub account linked; `repos` lists the repositories an installation reaches, one page at a time — the reply's `nextPage` names the `--installation-page` and `--repository-page` for the following one; `verify` checks an installation and its permissions before anything is linked, answering its findings as data rather than as an error. `get` asks only for workspace membership, `update` and `rm` ask for `manage_settings`, and `import` asks for task create and update.

Three of the routes — `repos`, `verify` and `connect` — need a user session rather than an API key: the server refuses a key with `403 A user session is required`, because linking a repository inherits the reach of the GitHub account behind the session. `import` works the repository in pages: the server answers 202 with the run's progress while pages remain and 200 once done, and each answer names the `runId` the next request continues. The command follows it to the end; repeating it — or passing `--run-id` — resumes where the run stopped rather than starting over, and the integration's `importProgress` keeps the last run's counts.

`kaneo integration` is the project's own event delivery, one integration per type: `mattermost` posts task events to a Mattermost incoming webhook, `webhook` POSTs them to any HTTP endpoint, signed with a secret when one is set — the POST creates or replaces the row, so re-running `set` with a fresh URL and secret is a rotation, not a second integration. `set` reads the project first — with no integration it creates one, and a new one is created active, so `--active` is refused there; with one it patches only the flags passed, so an omitted field keeps its stored value and each event toggle merges into the stored set rather than replacing it. The webhook URL is required to create and cannot be emptied afterwards; on Mattermost `--channel-name ''` clears the channel, and on the webhook an empty signing secret clears it. The URL and the secret are credentials — a value is refused, and each takes stdin through `-` or a file through `--webhook-url-file` or `--secret-file`, never both forms for one credential and never two readers of stdin in one command, so a create that wants both pipes the URL and points the secret at a file in a single `set`. A credential read from stdin or a file drops exactly one trailing line ending and is otherwise kept as it came; the server answers masked forms of them only. `rm` reads the row first and refuses without `--yes`. `--reminder-lead` on the webhook is how long before a due date the reminder event fires, 5 minutes to 30 days.

`kaneo feed` manages a project's calendar feeds: subscription links that serve the project's scheduled tasks — those with a start or due date and carrying any of the feed's labels — as an iCalendar document. `feed create` takes at least one label, by workspace label id or name, and `--time-zone` names the zone all-day dates are read in; left out, the server's UTC applies. A feed's subscribe link is the public half of `feed get <token>`: the route needs no key, which is what makes it pasteable into a calendar app, and `feed rm` revokes it for good — a feed created again gets a new token, so anything already subscribed has to be given the new link.

`instance`, `public`, `avatar get` and the assets a public project's shared description publishes answer without a key — the routes a shared link is served by — so those commands run with `KANEO_API_KEY` unset; any other asset is the exception and is sent the configured key when there is one. `asset get` and `avatar get` write raw bytes: to stdout as they arrived — a terminal and `--json`/`--jq` are refused there, since the bytes are the server's to choose — or to the file `--out` names, where `--json` then reports the path, size and content type rather than the bytes. `whoami avatar set` reads the image type off the file's extension, refuses anything but png, jpeg and webp, and refuses an empty file or one over the server's ~512 KiB limit before sending it.

`kaneo integration <provider>` manages where a project's events are posted: `slack` and `discord` through a webhook URL, `telegram` through a bot token and a chat id. `get` prints the configuration with the secret masked — the webhook URL keeps only its non-secret parts, the bot token keeps only the id before the colon — or `null` when the project has none. `set` creates the integration when the project has none and otherwise changes only the fields passed; the secret is never taken as a flag value, so --webhook\-url - and `--bot-token -` read it from stdin — one trailing line ending is dropped, and empty or all-whitespace stdin is refused rather than read as a secret. On update, `--channel-name ''`, `--thread-id ''` and `--chat-label ''` clear their fields, `--active=false` stops delivery without removing anything, and the `--task-*` event toggles merge into the stored set rather than replacing it. `rm --yes` deletes the integration.

### Shell completion

```bash
kaneo completion zsh > "${fpath[1]}/_kaneo"    # or bash, fish, powershell
```

Each sub-command writes the script for its shell and says where to put it. `--no-descriptions` leaves the descriptions out, which is what a shell that shows only the candidates wants.

### Agent sessions

The link between a session and a task is written into a task comment:

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

`session close` on a held task the server can no longer place (deleted, or out of the key's reach) releases the attachment anyway, writes the close to the history, runs the close hook, and exits 1 saying that no close marker was written. Any other failure of the marker keeps the attachment, so the close can be run again.

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

Data goes to stdout and progress goes to stderr, so piping into `jq` is always safe. Pipe stdout alone: notices such as how many tasks `task ls` left out go to stderr in every mode, and `2>&1` would put them in front of the JSON.

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
bun run parity:record              # rewrites only the goldens whose text this tree no longer writes, and writes new ones
git diff --stat tests/parity/golden/
```

Without an argument:

- it runs `src/index.ts` with the same `bun`, so the scenarios that point `PATH` at nothing still start
- it leaves alone every golden whose text it would write unchanged. The suite compares request bodies as JSON values, so a golden that differs only in key order still passes; it is rewritten anyway, so an order change shows up in the change that made it rather than in a later, unrelated one
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
