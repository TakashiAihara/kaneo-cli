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

A lane on the board. **A column's id is also the `status` value of every task in it** — there is no separate status vocabulary. The defaults are `to-do`, `in-progress`, `in-review` and `done`, but a project can define others, so nothing here treats that list as closed.

### task

A work item. Has a `number`, unique within its project and stable, which is what a person reads off the board. Its `id` is an opaque string, which is what the API takes.

Both are accepted wherever this CLI takes a task: a number, with or without a leading `#`, is looked up on the board first.

Tasks carry **no custom fields**. Anything a client wants to attach has to go in a comment.

### comment

A note on a task. Also the only place a client can store structured data of its own, for want of custom fields — see *session marker*.

`GET /task/export/{projectId}` does **not** include comments, so an export-and-reimport loses everything kept there.

### label

A tag, scoped to a workspace rather than a project.

### relation

A link between two tasks: `subtask`, `blocks` or `related`. For a subtask link the source is the parent. Relations cannot cross workspaces.

## This CLI's concepts

### operation

One server endpoint this client knows how to call, declared in the registry in `internal/api/registry.go` as an `operationId`, method, path template and the command that needs it.

The registry is the single source of truth: requests are built from it, and `kaneo api-check` compares the same entries against the server's OpenAPI document. An operation cannot be called without being declared, so the check cannot drift from what the client actually does.

### operationId

The server's own name for an endpoint, taken from its OpenAPI document. The key `api-check` matches on, because it survives a path being restructured.

### profile

A named set of connection settings — API URL, key, workspace, project — kept in `~/.config/kaneo/config.json` with mode `0600`. Switching profiles is how one machine talks to more than one Kaneo instance, or to more than one workspace.

### local config

A `.kaneo.json` naming a workspace and a project. Read from the current directory and every parent up to `$HOME`, nearest definition winning per field, so a parent can supply a workspace while a subdirectory overrides the project.

It carries **no credentials**: the file is meant to be committed, and a secret in it would leave with the repository.

### repo map

The `repos` table in the global config, mapping a git remote's `owner/repo` to a project id. It exists for repositories that cannot carry a `.kaneo.json` — one owned by someone else, for instance.

The key is `owner/repo` rather than a path because a working copy sits at a different absolute path on every machine, while the remote is the same everywhere.

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

### fail-open

Producing no output and exiting 0 on failure. `board` and the `session` commands do this because they run from a session-start hook, where a missing board is a smaller harm than a broken session. Every other command reports failures normally.

It covers failures that changed nothing: an unreachable server, a missing key, no project configured for this repository. A failure that already changed something elsewhere is *not* swallowed — `session attach` that wrote its comment to the server but could not record the attachment locally reports the failure, because staying quiet would leave `session next` believing nothing is attached and a retry would post a second marker.

`--strict` reports everything; `KANEO_DEBUG=1` prints the reason that was swallowed.

## Distinctions worth keeping straight

| Not the same | Difference |
| --- | --- |
| task `number` and task `id` | The number is per-project and human-facing; the id is opaque and what the API takes. Sending a number as an id makes the server answer `400 Workspace ID could not be determined`, which names neither |
| workspace and project | A workspace holds projects. `repos` maps a repo to a *project*; the workspace follows from it |
| status and column | The same string. A status *is* a column id |
| site root and API root | The root serves the web app and answers 200 with HTML for any path. Only `/api/...` is the API, which is why the configured URL is normalised to end in `/api` |
| `/auth/get-session` and `/auth/organization/list` | The first answers 200 with `null` for a valid key, an invalid key and no key, so it cannot check a credential. The second answers 401 on a bad key |
| a hosted remote and a local one | git accepts a filesystem path as a remote, and its trailing components look exactly like `owner/repo`. `/home/me/acme/thing` must not resolve to the `acme` workspace, so only SSH and URL remotes are parsed |
