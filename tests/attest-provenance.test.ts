import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimsFromPayload, provenancePredicate } from "../scripts/attest-provenance";

// scripts/attest-provenance.ts builds the SLSA predicate the release
// attestation carries. What is pinned here is the one field that differs
// from what actions/attest would auto-generate — resolvedDependencies'
// gitCommit names the built commit, not the event sha — and that every other
// field still comes from the OIDC claims unchanged. The spawned test stubs
// fetch the way spec-check.test.ts does, so the OIDC round trip is covered
// without a runner.

const CLAIMS = {
  ref: "refs/heads/main",
  repository: "TakashiAihara/kaneo-cli",
  event_name: "workflow_dispatch",
  repository_id: "123456789",
  repository_owner_id: "987654321",
  runner_environment: "github-hosted",
  job_workflow_ref: "TakashiAihara/kaneo-cli/.github/workflows/release.yml@refs/heads/main",
  workflow_ref: "TakashiAihara/kaneo-cli/.github/workflows/release.yml@refs/heads/main",
  run_id: "555",
  run_attempt: "1",
  sha: "e".repeat(40),
};

const BUILT = "b".repeat(40);

describe("provenancePredicate", () => {
  test("names the built commit as the source, not the event sha", () => {
    const p = provenancePredicate(CLAIMS, "https://github.com", BUILT);
    expect(p.buildDefinition.resolvedDependencies).toEqual([
      {
        uri: "git+https://github.com/TakashiAihara/kaneo-cli@refs/heads/main",
        digest: { gitCommit: BUILT },
      },
    ]);
  });

  test("keeps the workflow fields the action fills from the same claims", () => {
    const p = provenancePredicate(CLAIMS, "https://github.com", BUILT);
    expect(p.buildDefinition.buildType).toBe("https://actions.github.io/buildtypes/workflow/v1");
    expect(p.buildDefinition.externalParameters).toEqual({
      workflow: {
        ref: "refs/heads/main",
        repository: "https://github.com/TakashiAihara/kaneo-cli",
        path: ".github/workflows/release.yml",
      },
    });
    expect(p.buildDefinition.internalParameters).toEqual({
      github: {
        event_name: "workflow_dispatch",
        repository_id: "123456789",
        repository_owner_id: "987654321",
        runner_environment: "github-hosted",
      },
    });
    expect(p.runDetails).toEqual({
      builder: {
        id: "https://github.com/TakashiAihara/kaneo-cli/.github/workflows/release.yml@refs/heads/main",
      },
      metadata: {
        invocationId: "https://github.com/TakashiAihara/kaneo-cli/actions/runs/555/attempts/1",
      },
    });
  });
});

describe("claimsFromPayload", () => {
  test("returns the claims the predicate reads", () => {
    const claims = claimsFromPayload(CLAIMS);
    expect(claims.repository).toBe("TakashiAihara/kaneo-cli");
    expect(claims.run_attempt).toBe("1");
  });

  test("refuses a payload missing a claim the predicate needs", () => {
    const { run_attempt: _drop, ...rest } = CLAIMS;
    expect(() => claimsFromPayload(rest)).toThrow("missing claim run_attempt");
  });
});

// The script end to end: a stubbed fetch answers the OIDC request with a
// locally built JWT, and the printed predicate must name BUILT_SHA even
// though the token's own sha claim says otherwise.
const dir = mkdtempSync(join(tmpdir(), "attest-provenance-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stub = join(dir, "stub.ts");
writeFileSync(
  stub,
  `globalThis.fetch = async (url) => {
    await Bun.write(process.env.STUB_SEEN, String(url));
    return Response.json({ value: process.env.STUB_JWT });
  };`,
);

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: object): string => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;

const run = (env: Record<string, string>) => {
  const p = Bun.spawnSync(["bun", "--preload", stub, join(import.meta.dir, "../scripts/attest-provenance.ts")], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

const SEEN = join(dir, "seen");
const ENV = {
  BUILT_SHA: BUILT,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?audience=api%3A%2F%2Fdefault",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  GITHUB_SERVER_URL: "https://github.com",
  STUB_SEEN: SEEN,
};

test("prints a predicate naming BUILT_SHA, not the token's sha claim", () => {
  const r = run({ ...ENV, STUB_JWT: jwt(CLAIMS) });
  expect(r.code).toBe(0);
  const predicate = JSON.parse(r.stdout) as ReturnType<typeof provenancePredicate>;
  expect(predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit).toBe(BUILT);
  expect(readFileSync(SEEN, "utf8")).toBe(ENV.ACTIONS_ID_TOKEN_REQUEST_URL);
});

test("fails without BUILT_SHA", () => {
  const r = run({ ...ENV, BUILT_SHA: "", STUB_JWT: jwt(CLAIMS) });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("BUILT_SHA is not set");
});

test("fails when the token payload misses a claim", () => {
  const { run_attempt: _drop, ...rest } = CLAIMS;
  const r = run({ ...ENV, STUB_JWT: jwt(rest) });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("missing claim run_attempt");
});
