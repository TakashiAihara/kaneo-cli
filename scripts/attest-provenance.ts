// Writes the SLSA provenance predicate for the release attestation to stdout,
// for actions/attest-build-provenance's predicate-path input.
//
// The action's provenance mode fills resolvedDependencies.gitCommit from the
// OIDC token's sha claim — the commit the workflow run is for, which is not
// always the commit that was checked out and built: a workflow_dispatch can
// name another commit's tag, and a superseded run releases the newer main
// tip. The predicate is built here with the built commit passed explicitly
// and every other field taken from the same OIDC claims the action reads, so
// the attestation keeps the standard SLSA v1 shape and names the true source.

const REQUIRED_CLAIMS = [
  "ref",
  "repository",
  "event_name",
  "repository_id",
  "repository_owner_id",
  "runner_environment",
  "job_workflow_ref",
  "workflow_ref",
  "run_id",
  "run_attempt",
] as const;

export type OidcClaims = {
  [K in (typeof REQUIRED_CLAIMS)[number]]: string;
};

const GITHUB_BUILD_TYPE = "https://actions.github.io/buildtypes/workflow/v1";

// The predicate params the action would auto-generate, with gitCommit naming
// the built commit instead of the event sha. Kept field-for-field identical
// to @actions/attest's buildSLSAProvenancePredicate so verifiers see the same
// document; only the source commit differs.
export const provenancePredicate = (claims: OidcClaims, serverURL: string, gitCommit: string) => {
  // owner/repo/.github/workflows/release.yml@refs/heads/main =>
  // .github/workflows/release.yml
  const [workflowPath] = claims.workflow_ref.replace(`${claims.repository}/`, "").split("@");

  return {
    buildDefinition: {
      buildType: GITHUB_BUILD_TYPE,
      externalParameters: {
        workflow: {
          ref: claims.ref,
          repository: `${serverURL}/${claims.repository}`,
          path: workflowPath,
        },
      },
      internalParameters: {
        github: {
          event_name: claims.event_name,
          repository_id: claims.repository_id,
          repository_owner_id: claims.repository_owner_id,
          runner_environment: claims.runner_environment,
        },
      },
      resolvedDependencies: [
        {
          uri: `git+${serverURL}/${claims.repository}@${claims.ref}`,
          digest: {
            gitCommit,
          },
        },
      ],
    },
    runDetails: {
      builder: {
        id: `${serverURL}/${claims.job_workflow_ref}`,
      },
      metadata: {
        invocationId: `${serverURL}/${claims.repository}/actions/runs/${claims.run_id}/attempts/${claims.run_attempt}`,
      },
    },
  };
};

// The claims the predicate needs, or an error naming the first one missing.
// The OIDC payload is only read for these fields; the attestation's
// authenticity comes from the Sigstore certificate the action mints, not from
// this document.
export const claimsFromPayload = (payload: unknown): OidcClaims => {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("the OIDC token payload is not an object");
  }
  const record = payload as Record<string, unknown>;
  const claims = {} as OidcClaims;
  for (const key of REQUIRED_CLAIMS) {
    const value = record[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(`the OIDC token payload is missing claim ${key}`);
    }
    claims[key] = value;
  }
  return claims;
};

const claimsFromToken = (jwt: string): OidcClaims => {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("the OIDC response is not a JWT");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  } catch {
    throw new Error("the OIDC token payload is not JSON");
  }
  return claimsFromPayload(payload);
};

const main = async (): Promise<void> => {
  const built = process.env.BUILT_SHA;
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const serverURL = process.env.GITHUB_SERVER_URL;
  if (built === undefined || built === "") throw new Error("BUILT_SHA is not set");
  if (requestUrl === undefined || requestToken === undefined || serverURL === undefined) {
    throw new Error("the runner did not provide the OIDC request environment");
  }

  // The token's claims are the same whatever audience is asked for, and this
  // script only reads them — it never verifies the token — so the request
  // goes out with the URL's own audience, the way the runner wrote it.
  const res = await fetch(requestUrl, {
    headers: { authorization: `bearer ${requestToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`the OIDC token request failed with ${res.status}`);
  const body: unknown = await res.json();
  const value = typeof body === "object" && body !== null ? (body as { value?: unknown }).value : undefined;
  if (typeof value !== "string") throw new Error("the OIDC token response has no value");

  const claims = claimsFromToken(value);
  process.stdout.write(`${JSON.stringify(provenancePredicate(claims, serverURL, built))}\n`);
};

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`attest-provenance: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
