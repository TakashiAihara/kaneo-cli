# Moving the CLI from Go to Bun + TypeScript

## What it looks like when done

- `src/` is the whole CLI, run as `bun src/index.ts` in development and shipped as a standalone binary per target (`bun build --compile`)
- the commands, flags, output (`--json` and human), exit codes, config files and session markers are the ones the Go build had: every scenario in `tests/parity/` produces the same bytes as the Go build once the values that differ between machines (port, temporary HOME, host name, wall-clock times) are replaced with placeholders. Inputs outside the scenarios are not compared
- releases keep their archive names (`kaneo_<os>_<arch>.tar.gz`) and `checksums.txt`, so `install.sh` and existing installs upgrade in place, with one exception: the Linux binaries need glibc, so a host on a musl distribution (Alpine) that ran the static Go binary cannot run the new one
- releases are cut by `.github/workflows/release.yml` as before (every main push as the next rc, a final tag by hand); it builds with `scripts/build.ts` and publishes with `gh release`, where goreleaser built and published before
- `cmd/`, `internal/`, `go.mod`, `go.sum`, `Makefile` and `.goreleaser.yaml` are gone

## Why

- the choice between the two follows whether the process stays resident: for a resident process Go's memory and size win; for a command that starts, makes a few requests and exits, ease of change, maintenance and the TypeScript ecosystem weigh more
- a single binary without a runtime was the reason Go was chosen; `bun build --compile` also cross-compiles one per target for linux and darwin on amd64 and arm64, with the two differences below (glibc on Linux, and darwin binaries built but not yet run)
- what it costs, measured on 2026-10-03 with `kaneo --version` on linux/amd64 (median of 20 runs): startup 51 ms against 8 ms, peak RSS 40 MB against 9 MB, binary 83 MB against 12 MB unstripped (8 MB as released). The 43 ms is startup alone, and every invocation pays it: `session attach`, `next` and `close` from session hooks, `board` from a session start. A command's requests take tens of milliseconds each on top, the same for both builds
- the Linux binaries link against glibc, so a musl distribution (Alpine) cannot run them; the Go ones were static. amd64 is built for the baseline target, so AVX2 is not required
- the Go client generator needed an overlay for three faults of Go's type mapping (an empty schema becomes `struct{}`, a nullable field is tagged `omitempty`, `number` becomes `float32`). None of them exist in TypeScript; only the document's own fault (organization routes with empty schemas) still needs a correction
- Kaneo itself is TypeScript and zod; the generated zod schemas describe responses in the server's own terms

## Decisions

### Generation

- Orval 8 (`orval.config.ts`), fetch client, zod schemas, from `openapi/kaneo-2.29.2.json` copied unchanged from the release tag
- Orval filters by tag or schema, not operation id, so `openapi/transformer.ts` drops every operation outside `src/api/registry.ts` and every component no kept operation reaches
- `includeHttpResponseReturnType: false`: a generated call returns the body, and a failure throws from the transport. Callers never unpick a status union
- `includeZodSchemaInArguments: true`: the response schema reaches the transport, which validates

### Validation is lenient

- a deployed server older than the document omits fields the document declares (`backgroundVersion` on a project; confirmed against a live instance on 2026-10-03, where `listProjects`, `getProject` and `listTasks` failed strict parsing)
- the Go build decoded leniently, so this one does too: a body that fails its schema is returned as sent, and the mismatch is printed to stderr only when `KANEO_DEBUG` is set

### The transport (`src/api/http.ts`)

- `kaneoFetch` is the Orval mutator; `configureClient({ baseUrl, apiKey, timeoutMs, deadline, debug })` sets it up once per process
- `deadline` is the one budget the running command shares, built from `--timeout` where the Go build built one `context.Context` per command and passed it down. A `--timeout` of zero or less is a deadline that has already passed, as a `context.WithTimeout` of no duration is, rather than the default
- an empty reply is a body of no bytes, which is what the Go build's generated client measured: a 2xx carrying only whitespace is a reply that failed to decode (`unexpected end of JSON input`) and stopped the command there, rather than a set of zero values. Its message names the status, the content type, the length and the type the reply was read into (`GetProjectResponse` and the rest: the operation's id as Go spells it), which is read back out of `src/api/registry.ts` because the generated client here names no such type. The one request this CLI makes without the generated client — the `/openapi` document for `api-check` — is the Go build's `Client.Do`, and the one that trims a body before asking whether it holds anything
- its contract is `tests/http.test.ts`, ported from the Go client tests: `/api` prefix, bearer key, the key refused over plain HTTP except to loopback, the key dropped on a redirect to an insecure target, at most 10 redirects, a 301, 302 or 303 turning any method but GET and HEAD into a GET, `success:false` on a 2xx is a failure, the server's message kept whatever shape it arrives in, and a request cut short by the deadline with Go's wording for it

### What is not carried over

- the pre-Go TypeScript branch had `activity` and `search` commands the Go build never had. They are left out so the parity suite is the whole contract; adding them back is a separate change

## How it is verified

- `tests/parity/`: an in-memory Kaneo (`fake.ts`) that validates every request body and response against the generated schemas, and 98 scenarios (`scenarios.ts`): every command in `--json` and human form, help output, the config layers including invalid files, hooks, unreachable servers, timeouts, ids that need escaping, a server older than the document (`legacy`, where responses are not validated), and a host without git
- what the scenarios do not reach is held by unit tests ported from the Go build (`tests/unit/`: markers and their compatibility fixture, the session store, hooks) and by `tests/http.test.ts` (redirects, the key over plain HTTP)
- what neither covers: a darwin binary has not been run, only built
- shell completion is cobra's, kept as it was: `src/cli/completion-scripts.ts` holds the four generated scripts as templates with the program name, the ActiveHelp variable and the hidden command they call filled in, and the golden for `completion bash|zsh|fish|powershell` compares them byte for byte. `__complete` and `__completeNoDesc` are one command with two names, as in cobra, and nothing here checks what a shell makes of the answer
- `tests/parity/golden/` was recorded from the last Go build with `bun scripts/record-golden.ts <go binary>`. Running the suite with `KANEO_PARITY_BIN=<go binary>` passes every scenario, three runs in a row, so a failure against this build is a real difference
- values that differ for reasons outside the CLI (the fake's port, the temporary HOME, the host name, wall-clock times in logs) are replaced with placeholders before comparing
- manual check against a real Kaneo: `docs/design/bun-migration-manual-test.md`

## Order of work

1. transport: `src/api/http.ts` until `tests/http.test.ts` passes
2. core: config resolution, output, the root command, `context`, `whoami`, `workspace`, `api-check`, `--version`
3. `project`
4. `task`
5. `comment`, `session` (markers, store, hooks), `board`
6. delete the Go tree and the unused dependencies (`openapi-fetch`, `openapi-typescript`, `src/api/schema.d.ts`), and replace goreleaser in the release workflow with `scripts/build.ts` and `gh release`, keeping the archive names; `install.sh` was run against a local mirror of the new archives. The first release after the merge is checked by installing it with `install.sh` on linux/amd64 and linux/arm64

Each step is done when its parity scenarios pass and `bun run typecheck` is clean. The Go sources stay in the tree until step 6 as the reference for each step.
