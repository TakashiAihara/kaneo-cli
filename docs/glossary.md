# Glossary

Terms used across this codebase, the CLI's own output, and the Kaneo API. Where a name differs between the two, both are given: the API's vocabulary leaks into any client, and guessing at the mapping is how a client ends up calling the wrong endpoint.

## Kaneo concepts

### workspace

The top-level container. Owns members, roles and labels; contains projects.

The server models it as a [better-auth](https://better-auth.com) *organization*, which is why it is listed at `/auth/organization/list` rather than under `/workspace`. A single `/workspace/{id}/members` route exists, but everything else about a workspace lives under `/auth/organization/*`.

Data does not cross workspaces. A project cannot be moved between them, and a task cannot be related to one in another.

### project

A board, belonging to exactly one workspace. Holds columns, which hold tasks.

`GET /project` requires a `workspaceId` query parameter; without it the server answers 400 rather than listing everything.

### column

A lane on the board. **A column's slug is also the `status` value of every task in it** — there is no separate status vocabulary. The defaults are `to-do`, `in-progress`, `in-review` and `done`, but a project can define others, so nothing here treats that list as closed. Besides the columns, the server takes two statuses that no column holds, `planned` and `archived`.

`kaneo column` reads and changes them: `ls`, `create`, `rename`, `reorder`, `rm`, all against the resolved project. A column is named by its id (the opaque `id` in `kaneo column ls --json`), its slug, or its name when no other column shares it, anywhere one is taken. Its slug is derived from its name when the column is created and the server's update route takes no slug at all, which is why a rename leaves the slug, and every task's status in the column, as it was.

### planned task and archived task

A task the listing answers beside the columns, in `plannedTasks` and `archivedTasks`, rather than in one of them: a planned task has not been picked up, an archived one has been filed away. Their `status` is `planned` or `archived`, which is the one place a status names no column of the project.

`kaneo` reads both as two columns of their own, appended after the real ones. `task ls` leaves them out unless `--all` or an explicit `--status` asks for them, and `board` shows neither.

### task

A work item. Has a `number`, unique within its project and stable, which is what a person reads off the board. Its `id` is an opaque string, which is what the API takes.

Both are accepted wherever this CLI takes a task: a number, with or without a leading `#`, is looked up on the board first.

Tasks carry **no custom fields**. Anything a client wants to attach has to go in a comment.

### comment

A note on a task. Also the only place a client can store structured data of its own, for want of custom fields — see *session marker*.

`GET /task/export/{projectId}` does **not** include comments, so an export-and-reimport loses everything kept there.

### activity

One entry of a task's history (`GET /activity/{taskId}`): a comment, or an event the server records such as `status_changed`, whose details are in `eventData`. A comment's activity id is its comment id, so the API's `/activity/comment` routes and its `/comment` routes reach the same rows; this CLI uses only the `/comment` ones, which also refuse empty text and check the `task:update` permission.

`kaneo activity add` writes an entry into the history and nothing else: the task does not change, and no route removes the entry on its own (deleting the task removes its history). Type `comment` is refused (Kaneo 2.27.0 and later refuse it too). Servers before Kaneo 2.23.0 also want a `userId` in that request, and answer 400 without one.

### label

A tag, scoped to a workspace rather than a project. The server keeps two kinds of row in one `label` table, and the CLI's words for them are:

- workspace label: `taskId` null. What the web app offers to pick from, and what `kaneo label ls` lists.
- task copy: a row with the same name and its own id, inserted on a task when the label is attached and deleted when it is detached. Renaming or deleting the workspace label carries over to its copies; a deletion takes the copies that existed when it started, so one attached while it is still running stays. `kaneo label detach` and `DELETE /label/{id}/task` take the copy's id, not the workspace label's.

### relation

A link between two tasks: `subtask`, `blocks` or `related`. Relations cannot cross workspaces.

The type carries the direction, so the same link reads as two different words depending on which end it is read from. `task links` and `task get` word it from the task being shown: `blocks` / `blocked by`, `parent of` / `subtask of` (a subtask link's source is the parent), and `related`, which has no direction.

The listing answers with a summary of each task at either end, so a link is shown by number and title. Where a summary or its number is null, which the server's document allows, the task's id is shown instead.

## This CLI's concepts

### task reference

What a task is named by on a command line: a task id, a number with or without a leading `#`, or `<project-slug>#<number>`.

The last form names a board as well as a number, which is why it is the form a task reference is written in everywhere else — `KANEO_TASK_REF` and the `kaneo <project slug>#<number>` a session hook receives. The part before the `#` is resolved as a project by id, slug or name; the leading `kaneo ` is not part of what the commands take.

### operation

One server endpoint this client knows how to call, declared in the registry in `src/api/registry.ts` as an `operationId`, method, path template and the command that needs it.

Requests are made by the generated client (`src/api/gen`), which is generated for exactly the operations in the registry: `openapi/transformer.ts` drops every other operation before generation, and `tests/registry.test.ts` fails when the registry, the generated client and the pinned OpenAPI document disagree on an operation's id, method or path. Request bodies and parameters are typed by the generated code, not by the registry.

`kaneo api-check` compares the registry's operation ids against a live server's document. It says whether the server still offers each operation; it does not compare request bodies, so it would not catch a field the server renamed.

### pinned spec

`openapi/kaneo-<version>.json`: the OpenAPI document shipped in that Kaneo release, copied unchanged. The generated client is built from it through `openapi/transformer.ts`, which corrects what the document gets wrong. Not to be confused with the document a running server serves at `/api/openapi`, which is what `api-check` reads and which follows whatever version that server runs.

### operationId

The server's own name for an endpoint, taken from its OpenAPI document. The key `api-check` matches on, because it survives a path being restructured.

### profile

A named set of connection settings — API URL, key, workspace, project — kept in `~/.config/kaneo/config.json` with mode `0600`. Switching profiles is how one machine talks to more than one Kaneo instance, or to more than one workspace.

### local config

A `.kaneo.json` naming a workspace and a project. Read from the current directory and every parent up to `$HOME`, nearest definition winning per field, so a parent can supply a workspace while a subdirectory overrides the project.

It carries **no credentials**: the file is meant to be committed, and a secret in it would leave with the repository.

### repo map

The `repos` table in the global config, mapping a git remote's `owner/repo` to the projects it is tied to. It exists for repositories that cannot carry a `.kaneo.json` — one owned by someone else, for instance.

The value is either one project id or a list of them; both forms mean the same thing, and a lone id is written back as it was read. It is the only layer that can answer with more than one project, and `board` is the only command that takes more than one.

The key is `owner/repo` rather than a path because a working copy sits at a different absolute path on every machine, while the remote is the same everywhere.

### archived project

A project the server has stamped with `archivedAt`. `board` leaves it out, `project ls` leaves it out unless asked, and everything about it stays where it was.

It exists because projects are made per plan rather than per repository, so a repository accumulates finished ones. Dropping a finished project from the repo map would clear the board too, but it would also lose the record that the repository ever had that work. Archiving is reversible; editing the map is not.

### origin

Which layer of the resolution chain supplied a given setting. Reported by `kaneo context` so a surprising value can be traced rather than guessed at.

### session marker

An HTML comment written into a task comment, recording that an agent session holds that task:

```text
<!-- kn:session id=... host=... cwd=... branch=... state=running -->
```

The prefix is `kn:` rather than `kaneo:` because that is what is already written on existing boards, by the Python `kn` this CLI replaces. Both read the same board during the changeover, so the format cannot change.

`state` is `running` or `closed`. Each of attach, next and close appends its own comment, so a session leaves a trail; only the newest marker per session id describes the current state.

Values are percent-encoded where they contain whitespace. Fields are separated by spaces, so a raw space inside a value is indistinguishable from the start of the next field — a path like `/work/client foo=bar` would otherwise be read back as `/work/client`. Markers written by the older implementation carry raw values and are still read as-is.

### attachment

The record of which task a session currently holds, written beside the markers as `~/.config/kaneo/sessions/<session id>.json` when `session attach` succeeds and removed when the session closes that task. It carries the task's id, number and title, and the project and workspace it is on — including the project slug, which is what a task reference is written as, so a reader can print `slug#number` without an API call. Each of those is left out when unknown rather than written empty.

### attach history

Every attach and close a session made, one JSON line each in `~/.config/kaneo/sessions/<session id>.history.jsonl`, holding the time, the task and the board as the attachment had it at that moment. Lines are only ever appended to.

It exists because the attachment is deleted on close, which leaves nothing that says the session was ever working on anything; a retro or a check that runs afterwards reads this instead. It is kept for that reason alone: the attachment stays the record of what is held *now*, since other tools read it as "currently attached", and a history that outlived every close would say nothing about the present. `session status` prints both, from these files alone.

### fail-open

Producing no output and exiting 0 on failure. The `session` commands do this because they run from a session-start hook, where a missing board is a smaller harm than a broken session. Every other command reports failures normally, `board` included: its callers read the board to decide something, and an empty answer from a failure read as "no tasks" (#16).

It covers failures that changed nothing: an unreachable server, a missing key, no project configured for this repository. A failure that already changed something elsewhere is *not* swallowed — `session attach` that wrote its comment to the server but could not record the attachment locally reports the failure, because staying quiet would leave `session next` believing nothing is attached and a retry would post a second marker.

`--strict` reports everything; `KANEO_DEBUG=1` prints the reason that was swallowed.

## Distinctions worth keeping straight

| Not the same | Difference |
| --- | --- |
| task `number` and task `id` | The number is per-project and human-facing; the id is opaque and what the API takes. Sending a number as an id makes the server answer `400 Workspace ID could not be determined`, which names neither |
| a project's `id`, `slug` and `name` | Three names for one board. The API takes the id, so the other two are resolved to it by looking the value up across the workspaces the key can see, and only once the server has said it does not know it — a value that works as an id costs no extra request |
| workspace and project | A workspace holds projects. `repos` maps a repo to a *project*; the workspace follows from it |
| reading a board and writing to one | `board` reads, so it can cover several projects at once. Everything else writes, and a write has to name the board it lands on — so a repository mapped to several projects makes those commands ask for `--project` rather than pick |
| status and column | The same string. A status *is* a column slug |
| column id and column slug | `kaneo column ls --json` shows both. The id is opaque and is what the column routes take; the slug is the status. The board route reports a column's `id` as its slug, so only the column routes show the opaque one |
| site root and API root | The root serves the web app and answers 200 with HTML for any path. Only `/api/...` is the API, which is why the configured URL is normalised to end in `/api` |
| `/auth/get-session` and `/auth/organization/list` | The first answers 200 with `null` for a valid key, an invalid key and no key, so it cannot check a credential. The second answers 401 on a bad key |
| a hosted remote and a local one | git accepts a filesystem path as a remote, and its trailing components look exactly like `owner/repo`. `/home/me/acme/thing` must not resolve to the `acme` workspace, so only SSH and URL remotes are parsed |
