import { afterEach, expect, test } from "bun:test";
import { configureClient } from "../../src/api/http";
import * as api from "../../src/api/kaneo";

// The GitLab wrappers against a local Bun.serve, reading what each call put on
// the wire the way tests/unit/operations.test.ts does for the rest of the API.

type Handler = (req: Request) => Response | Promise<Response>;
const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

const newServer = (handler: Handler) => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(s);
  configureClient({ baseUrl: `http://127.0.0.1:${s.port}`, apiKey: "test-key" });
};

type Seen = { method: string; path: string; query: string; body: string };

const recorder = (reply: string) => {
  const seen: Seen = { method: "", path: "", query: "", body: "" };
  newServer(async (req) => {
    const url = new URL(req.url);
    Object.assign(seen, {
      method: req.method,
      path: url.pathname,
      query: url.search.replace(/^\?/, ""),
      body: await req.text(),
    });
    return new Response(reply, { headers: { "content-type": "application/json" } });
  });
  return seen;
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail, and it succeeded");
};

const TIME = "2026-01-01T00:00:00.000Z";

const integrationReply = (extra = "") =>
  `{"id":"gitl1","projectId":"p1","baseUrl":"https://gitlab.example.com","projectPath":"acme/web","tokenType":"private","maskedAccessToken":"glpa••••1234","webhookUrl":"https://kaneo.example.com/api/gitlab-integration/webhook/gitl1","webhookSecret":"whsec","branchPattern":"{slug}-{number}","commentTaskLinkOnGitlabIssue":true,"isActive":true,"createdAt":"${TIME}","updatedAt":"${TIME}"${extra}}`;

// The check-before-connect calls carry the Kaneo project and the GitLab
// credentials in one body; the token is in it because that is the API's shape,
// and nowhere else.
test("listGitlabProjects posts the query and maps the projects", async () => {
  const seen = recorder(
    JSON.stringify({
      projects: [
        {
          id: 101,
          name: "Web",
          path_with_namespace: "acme/web",
          name_with_namespace: "Acme / Web",
          visibility: "private",
          web_url: "https://gitlab.example.com/acme/web",
        },
      ],
    }),
  );
  const projects = await api.listGitlabProjects({
    projectId: "p1",
    baseUrl: "https://gitlab.example.com",
    accessToken: "tok",
    tokenType: "bearer",
  });
  expect([seen.method, seen.path]).toEqual(["POST", "/api/gitlab-integration/projects"]);
  expect(JSON.parse(seen.body)).toEqual({
    projectId: "p1",
    baseUrl: "https://gitlab.example.com",
    accessToken: "tok",
    tokenType: "bearer",
  });
  expect(projects).toEqual([
    {
      id: 101,
      name: "Web",
      path_with_namespace: "acme/web",
      name_with_namespace: "Acme / Web",
      visibility: "private",
      web_url: "https://gitlab.example.com/acme/web",
    },
  ]);
});

test("listGitlabProjects reads a reply without the list as empty", async () => {
  recorder("{}");
  expect(
    await api.listGitlabProjects({ projectId: "p1", baseUrl: "https://gitlab.example.com", accessToken: "tok" }),
  ).toEqual([]);
});

test("verifyGitlabAccess posts the check and maps the verdict", async () => {
  const seen = recorder(
    JSON.stringify({
      isInstalled: true,
      hasRequiredPermissions: false,
      projectExists: true,
      projectVisibility: "private",
      missingPermissions: ["api"],
      message: "Token lacks api scope",
      failureReason: null,
    }),
  );
  const verdict = await api.verifyGitlabAccess({
    projectId: "p1",
    baseUrl: "https://gitlab.example.com",
    accessToken: "tok",
    projectPath: "acme/web",
  });
  expect([seen.method, seen.path]).toEqual(["POST", "/api/gitlab-integration/verify"]);
  expect(JSON.parse(seen.body)).toEqual({
    projectId: "p1",
    baseUrl: "https://gitlab.example.com",
    accessToken: "tok",
    projectPath: "acme/web",
  });
  expect(verdict).toEqual({
    isInstalled: true,
    hasRequiredPermissions: false,
    projectExists: true,
    projectVisibility: "private",
    missingPermissions: ["api"],
    message: "Token lacks api scope",
    failureReason: null,
  });
});

test("verifyGitlabAccess keeps a named failure reason and absent lists empty", async () => {
  recorder(
    JSON.stringify({
      isInstalled: false,
      hasRequiredPermissions: false,
      projectExists: false,
      projectVisibility: null,
      message: "That is not a GitLab instance",
      failureReason: "not_a_gitlab_instance",
    }),
  );
  const verdict = await api.verifyGitlabAccess({
    projectId: "p1",
    baseUrl: "https://example.com",
    accessToken: "tok",
    projectPath: "acme/web",
  });
  expect(verdict.failureReason).toBe("not_a_gitlab_instance");
  expect(verdict.missingPermissions).toEqual([]);
});

test("getGitlabIntegration reads the stored link and maps absent optionals to null", async () => {
  const seen = recorder(integrationReply());
  const found = await api.getGitlabIntegration("p/1");
  expect([seen.method, seen.path]).toEqual(["GET", "/api/gitlab-integration/project/p%2F1"]);
  expect(found).toEqual({
    id: "gitl1",
    projectId: "p1",
    baseUrl: "https://gitlab.example.com",
    projectPath: "acme/web",
    tokenType: "private",
    maskedAccessToken: "glpa••••1234",
    webhookUrl: "https://kaneo.example.com/api/gitlab-integration/webhook/gitl1",
    webhookSecret: "whsec",
    branchPattern: "{slug}-{number}",
    commentTaskLinkOnGitlabIssue: true,
    isActive: true,
    createdAt: TIME,
    updatedAt: TIME,
  });
});

test("getGitlabIntegration answers null for a project with no link", async () => {
  recorder("null");
  expect(await api.getGitlabIntegration("p1")).toBeNull();
});

test("getGitlabIntegration reads bearer and leaves out what the server left out", async () => {
  recorder(
    `{"id":"gitl2","projectId":"p1","baseUrl":"https://gitlab.example.com","projectPath":"acme/web","tokenType":"bearer","maskedAccessToken":"","webhookUrl":"","webhookSecret":"","isActive":null,"createdAt":"${TIME}","updatedAt":"${TIME}"}`,
  );
  const found = await api.getGitlabIntegration("p1");
  expect(found?.tokenType).toBe("bearer");
  expect(found?.branchPattern).toBeNull();
  expect(found?.commentTaskLinkOnGitlabIssue).toBeNull();
  expect(found?.isActive).toBeNull();
});

test("createGitlabIntegration posts the link and answers the stored one", async () => {
  const seen = recorder(integrationReply());
  const created = await api.createGitlabIntegration("p1", {
    baseUrl: "https://gitlab.example.com",
    projectPath: "acme/web",
    accessToken: "tok",
    tokenType: "private",
  });
  expect([seen.method, seen.path]).toEqual(["POST", "/api/gitlab-integration/project/p1"]);
  expect(JSON.parse(seen.body)).toEqual({
    baseUrl: "https://gitlab.example.com",
    projectPath: "acme/web",
    accessToken: "tok",
    tokenType: "private",
  });
  expect(created.id).toBe("gitl1");
});

// A write that answers null did not say what it stored; reporting that as a
// link would be the opposite of what happened.
test.each([
  [
    "create",
    (_s: Seen) => api.createGitlabIntegration("p1", { baseUrl: "https://gitlab.example.com", projectPath: "acme/web" }),
  ],
  ["update", (_s: Seen) => api.updateGitlabIntegration("p1", { isActive: false })],
])("%s with a null reply fails rather than reporting no link", async (_name, call) => {
  const seen = recorder("null");
  const err = await failure(call(seen));
  expect(String(err)).toContain("the server answered without the integration");
});

test("updateGitlabIntegration patches only what was passed", async () => {
  const seen = recorder(integrationReply());
  await api.updateGitlabIntegration("p1", { isActive: false, commentTaskLinkOnGitlabIssue: false });
  expect([seen.method, seen.path]).toEqual(["PATCH", "/api/gitlab-integration/project/p1"]);
  expect(JSON.parse(seen.body)).toEqual({ isActive: false, commentTaskLinkOnGitlabIssue: false });
});

test("deleteGitlabIntegration deletes the link", async () => {
  const seen = recorder(JSON.stringify({ success: true, message: "GitLab integration deleted" }));
  const result = await api.deleteGitlabIntegration("p1");
  expect([seen.method, seen.path]).toEqual(["DELETE", "/api/gitlab-integration/project/p1"]);
  expect(result).toEqual({ success: true, message: "GitLab integration deleted" });
});

test("importGitlabIssues posts the project and maps the counts and errors", async () => {
  const seen = recorder(JSON.stringify({ imported: 3, updated: 1, skipped: 2, errors: ["issue 9: confidential"] }));
  const result = await api.importGitlabIssues("p1");
  expect([seen.method, seen.path]).toEqual(["POST", "/api/gitlab-integration/import-issues"]);
  expect(JSON.parse(seen.body)).toEqual({ projectId: "p1" });
  expect(result).toEqual({ imported: 3, updated: 1, skipped: 2, errors: ["issue 9: confidential"] });
});

test("importGitlabIssues leaves errors absent when the server sends none", async () => {
  recorder(JSON.stringify({ imported: 1, updated: 0, skipped: 0 }));
  const result = await api.importGitlabIssues("p1");
  expect("errors" in result).toBe(false);
});
