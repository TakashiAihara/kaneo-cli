# Design 0001: CLI architecture

Status: accepted (2026-08-28)

## Goal

A general-purpose command-line interface for [Kaneo](https://github.com/usekaneo/kaneo), the open source project management tool. Kaneo has no official CLI; its `DEVICE_AUTH_CLIENT_IDS` already allows a `kaneo-cli` client id by default, so the ecosystem slot exists upstream.

Scope: task CRUD, project/workspace management, comments/activity, search/labels/time entries. Out of scope for now: notification settings (no API coverage), integrations (GitHub/Slack/Discord/Telegram/Gitea), instance deployment (that is `usekaneo/drim`).

## Decisions

### Runtime and libraries

- Bun + TypeScript, `commander` for the command tree.
- Schema-first: types are generated from a committed snapshot of upstream `apps/docs/openapi.json` (111 paths) with `openapi-typescript`, and requests go through `openapi-fetch`. No hand-written endpoint types.
  - Rejected: hand-rolled fetch wrappers per endpoint — drifts from upstream and duplicates 111 paths of typing work.
  - Rejected: pointing the generator at a live instance — the deployed image can lag upstream `main`, and `/openapi.json` on an instance serves the SPA shell, not the spec.
- The spec snapshot (`openapi.json` at repo root) is committed. Refresh procedure lives in the README; generated `src/api/schema.d.ts` is also committed so `bunx`/clone users need no generation step.

### Auth and configuration

- Credential resolution order, most specific wins: `--token` flag > `KANEO_TOKEN` env > profile in `~/.config/kaneo/config.json` (respecting `XDG_CONFIG_HOME`). Same for the URL (`--url` > `KANEO_URL` > profile).
- Profiles support multiple instances: `--profile` flag > `KANEO_PROFILE` env > `defaultProfile` key.
- Auth header is `Authorization: Bearer <token>`; Kaneo accepts both API keys and session tokens there (verified against `authenticateApiRequest` upstream).
- A broken config file fails closed with an error instead of being treated as empty — silently ignoring it would surface as an inexplicable auth failure.
- Device authorization login (`kaneo login`) is a later phase; API keys cover all functionality today.

### Behavior contracts

- stdout carries data, stderr carries logs. `--json` prints raw API JSON to stdout with nothing else mixed in.
- Human-readable output is the default; `--json` is the machine escape hatch (gh-style).
- Exit codes: 0 success, 1 config/API error, 2 usage error (commander default).
- The API base path is always `<instance>/api`; `normalizeUrl()` accepts the instance URL with or without `/api` and normalizes.
- `whoami` must not trust `GET /auth/get-session` alone: Kaneo returns `200 null` there for invalid tokens as well as for API keys. It therefore also hits an auth-required endpoint (`GET /notification`) to distinguish "valid API key" from "invalid token" (verified against a live instance, 2026-08-28).

### Known constraint: spec vs instance drift

The committed spec tracks upstream `main`; a self-hosted instance may be older. A 404 on a documented route usually means instance lag, not a CLI bug. Error output for 404 says so.

## Phases (each merges in a working state)

1. Scaffold: config/auth resolution, generated client, `whoami`, `--json`, tests. (this PR)
2. `task` commands: list / view / create / edit / move / delete.
3. `project` / `workspace` commands.
4. `comment` / `activity` / `search`.
5. `label` / `time-entry`.
6. `kaneo login` (device authorization, client id `kaneo-cli`).
7. Publish: README polish, npm package. Package name and license are tracked as open decisions until publish.
