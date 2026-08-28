# Glossary

Terms used across kaneo-cli code, docs, and command output. One term, one meaning. Each definition names where it exists in the Kaneo API so it can be verified, not believed.

## Conflicting terms (read this first)

### workspace / organization

Kaneo is migrating workspaces onto better-auth "organizations". The API exposes both `/workspace/{workspaceId}/members` (legacy) and `/auth/organization/*` (current). In kaneo-cli, the user-facing word is always **workspace**; which endpoint gets called is an implementation detail hidden inside the API layer. Never surface "organization" in command names, flags, or output.

### status / column

A task's `status` is **the slug of the column it sits in** (see `POST /task/{projectId}` request schema: `status: "The target column's slug."`). It is not a fixed enum; each project defines its own columns via `/column/{projectId}`. In prose and help text, use **status** for the value on a task and **column** for the board structure it refers to.

### id / number

Tasks have both an `id` (opaque unique string, used in API paths) and a `number` (human-facing per-project sequence shown in the UI as `#12`). CLI commands accept ids in API calls; where we accept numbers for convenience, the code must resolve number → id explicitly and say so.

### token / API key

Both authenticate via the same `Authorization: Bearer` header. A **session token** resolves to a user via `/auth/get-session`; an **API key** does not (get-session returns `200 null` for it — that is not an auth failure). Code and docs say **token** for the credential the CLI carries, and **API key** only when the distinction matters.

## Plain terms

### profile

A named `{url, token}` pair in `~/.config/kaneo/config.json`, selected via `--profile` / `KANEO_PROFILE` / `defaultProfile`. Exists only in kaneo-cli, not in the Kaneo API.

### instance

A deployed Kaneo server, identified by its base URL. The API lives under `<instance>/api`; `normalizeUrl()` in `src/config.ts` enforces this.

### priority

Fixed enum on tasks: `no-priority | low | medium | high | urgent` (see `POST /task/{projectId}` request schema).

### board

The column-grouped task view returned by `GET /task/tasks/{projectId}` (`BoardResponse` schema). "Board" always means this response shape, not a separate resource.
