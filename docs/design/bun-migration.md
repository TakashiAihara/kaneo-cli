# Moving the CLI from Go to Bun + TypeScript

## What it looks like when done

- `src/` is the whole CLI, run as `bun src/index.ts` in development and shipped as a standalone binary per target (`bun build --compile`)
- the commands, flags, output (`--json` and human), exit codes, config files and session markers are the ones the Go build had: every scenario in `tests/parity/` produces byte-identical results
- releases keep their archive names (`kaneo_<os>_<arch>.tar.gz`) and `checksums.txt`, so `install.sh` and existing installs are unaffected
- `cmd/`, `internal/`, `go.mod`, `go.sum`, `Makefile` and `.goreleaser.yaml` are gone

## Why

- the CLI is a short-lived process: start, make a few requests, exit. Go's advantages (memory, binary size, startup) matter for a resident process and barely here
- a single binary without a runtime was the reason Go was chosen; `bun build --compile` cross-compiles to linux and darwin on amd64 and arm64 just as well. The cost is size: about 80 MB per binary against Go's 8 MB
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

- `kaneoFetch` is the Orval mutator; `configureClient({ baseUrl, apiKey, timeoutMs, debug })` sets it up once per process
- its contract is `tests/http.test.ts`, ported from the Go client tests: `/api` prefix, bearer key, the key refused over plain HTTP except to loopback, the key dropped on a redirect to an insecure target, at most 10 redirects, `success:false` on a 2xx is a failure, the server's message kept whatever shape it arrives in, a timeout per request

### What is not carried over

- the pre-Go TypeScript branch had `activity` and `search` commands the Go build never had. They are left out so the parity suite is the whole contract; adding them back is a separate change

## How it is verified

- `tests/parity/`: an in-memory Kaneo (`fake.ts`) that validates every request body and response against the generated schemas, and scenarios (`scenarios.ts`) covering every command, the config layers, hooks and failure paths
- `tests/parity/golden/` was recorded from the last Go build with `bun scripts/record-golden.ts <go binary>`. Running the suite with `KANEO_PARITY_BIN=<go binary>` passes every scenario, three runs in a row, so a failure against this build is a real difference
- values that differ for reasons outside the CLI (the fake's port, the temporary HOME, the host name, wall-clock times in logs) are replaced with placeholders before comparing
- manual check against a real Kaneo: `docs/design/bun-migration-manual-test.md`

## Order of work

1. transport: `src/api/http.ts` until `tests/http.test.ts` passes
2. core: config resolution, output, the root command, `context`, `whoami`, `workspace`, `api-check`, `--version`
3. `project`
4. `task`
5. `comment`, `session` (markers, store, hooks), `board`
6. delete the Go tree and the unused dependencies (`openapi-fetch`, `openapi-typescript`, `src/api/schema.d.ts`)

Each step is done when its parity scenarios pass and `bun run typecheck` is clean. The Go sources stay in the tree until step 6 as the reference for each step.
