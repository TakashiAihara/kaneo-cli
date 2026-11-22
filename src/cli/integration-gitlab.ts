import { apiKey, project, type App } from "./app";
import {
  createGitlabIntegration,
  deleteGitlabIntegration,
  getGitlabIntegration,
  importGitlabIssues,
  listGitlabProjects,
  updateGitlabIntegration,
  verifyGitlabAccess,
  type GitlabIntegration,
  type GitlabLink,
  type GitlabLinkChanges,
  type GitlabProject,
  type GitlabVerification,
} from "../api/kaneo";
import { noArgs, type Flag, type FlagValues, type RunContext } from "./args";
import { readInput } from "./input";
import { withProject } from "./lookup";

const boolFlag = (name: string, usage: string): Flag => ({ name, type: "bool", usage, defaultValue: "false" });
const stringFlag = (name: string, usage: string): Flag => ({ name, type: "string", usage, defaultValue: "" });

// The GitLab token is a secret, and unlike the notification secrets it is
// never taken as a flag value: --access-token - is the only accepted spelling,
// and it reads the token from stdin so the value stays out of the process
// list and the shell history. One trailing line ending is dropped, the way a
// pipe or a heredoc carries it; empty stdin is refused rather than read as a
// token, and a token that is exactly - cannot be passed as a value.
const accessToken = async (
  flags: FlagValues,
  changed: ReadonlySet<string>,
  required: boolean,
): Promise<string | undefined> => {
  if (!changed.has("access-token")) {
    if (required)
      throw new Error("--access-token is required: pass --access-token - to read the GitLab token from stdin");
    return undefined;
  }
  if (String(flags["access-token"] ?? "") !== "-") {
    throw new Error(
      "--access-token takes only -: the GitLab token is read from stdin so it never appears on the command line",
    );
  }
  const token = (await readInput("-")).replace(/\r?\n$/, "");
  if (token === "") throw new Error("empty access token on stdin");
  return token;
};

const tokenType = (flags: FlagValues): "private" | "bearer" | undefined => {
  const given = String(flags["token-type"] ?? "");
  if (given === "") return undefined;
  if (given !== "private" && given !== "bearer") {
    throw new Error(`--token-type must be private or bearer, not ${JSON.stringify(given)}`);
  }
  return given;
};

const required = (flags: FlagValues, name: string, what: string): string => {
  const value = String(flags[name] ?? "").trim();
  if (value === "") throw new Error(`--${name} is required: ${what}`);
  return value;
};

const nothingToChange = (changed: ReadonlySet<string>, names: readonly string[]): void => {
  if (!names.some((name) => changed.has(name))) {
    throw new Error(`nothing to change: pass at least one of ${names.map((n) => `--${n}`).join(", ")}`);
  }
};

const yesNo = (value: boolean | null): string => (value === null ? "unknown" : value ? "yes" : "no");

// The fields of a stored integration a person needs, one per line under the
// command's own summary. The label column is padded so every value starts at
// the same place; "webhook secret" is the longest label and sets the width.
const detail = (label: string, value: string): string => `${label.padEnd(15)}${value}`;

const integrationLines = (i: GitlabIntegration): string[] => [
  detail("project", i.projectId),
  detail("gitlab", `${i.baseUrl} ${i.projectPath}`),
  detail("token", `${i.tokenType} ${i.maskedAccessToken}`.trimEnd()),
  detail("webhook", i.webhookUrl),
  // An empty secret means the caller may not manage the workspace's settings;
  // there is nothing to paste into GitLab, so the line is left out.
  ...(i.webhookSecret === "" ? [] : [detail("webhook secret", i.webhookSecret)]),
  ...(i.branchPattern === null ? [] : [detail("branch", i.branchPattern)]),
  detail("comment link", yesNo(i.commentTaskLinkOnGitlabIssue)),
  detail("active", yesNo(i.isActive)),
];

const verificationLines = (v: GitlabVerification): string[] => [
  v.message,
  `gitlab instance ${yesNo(v.isInstalled)}  project exists ${yesNo(v.projectExists)}  required permissions ${yesNo(v.hasRequiredPermissions)}`,
  ...(v.projectVisibility === null ? [] : [`visibility ${v.projectVisibility}`]),
  ...(v.missingPermissions.length === 0 ? [] : [`missing ${v.missingPermissions.join(", ")}`]),
  ...(v.failureReason === null ? [] : [`reason ${v.failureReason}`]),
];

const projectLine = (p: GitlabProject): string => `${p.id}  ${p.path_with_namespace}  ${p.visibility}  ${p.web_url}`;

// The flags the check-before-connect calls share: where the GitLab instance
// is, the token that reaches it, and how the token is sent.
const credentials = [
  stringFlag("base-url", "root URL of the GitLab instance"),
  stringFlag("access-token", "GitLab access token; only - is accepted, which reads it from stdin"),
  stringFlag("token-type", "private sends PRIVATE-TOKEN, bearer sends Authorization; default private"),
];

export const gitlabCommand = {
  name: "gitlab",
  short: "Work with the project's GitLab integration",
  children: [
    {
      name: "get",
      short: "Show the project's stored GitLab integration",
      long:
        "Show the project's stored GitLab integration, or report that none is configured.\n\n" +
        "The masked token, the webhook URL and the webhook secret are shown only to a\n" +
        "key that may manage the workspace's settings; for anyone else the server\n" +
        "answers the secrets empty.",
      args: noArgs("kaneo integration gitlab get"),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const found = await withProject(project(app), (id) => getGitlabIntegration(id));
        if (found === null) {
          app.out.human("no GitLab integration is configured for this project");
          app.out.data(null);
          return;
        }
        for (const line of integrationLines(found)) app.out.human(line);
        app.out.data(found);
      },
    },
    {
      name: "connect",
      short: "Link the project to a GitLab project",
      long:
        "Link the project to a GitLab project.\n\n" +
        "Kaneo generates the secret GitLab must send with each webhook; add the\n" +
        "webhook it answers with in GitLab afterwards. Check that the token reaches\n" +
        "the project first with `kaneo integration gitlab verify`.\n\n" +
        "--access-token takes only -, which reads the token from stdin.\n\n" +
        "Connecting again keeps the stored token while the GitLab URL is unchanged;\n" +
        "a different URL needs a new token, and the server says so.",
      args: noArgs("kaneo integration gitlab connect"),
      flags: [
        stringFlag("base-url", "root URL of the GitLab instance"),
        stringFlag("project-path", "full path of the GitLab project, nested groups included"),
        stringFlag("access-token", "GitLab access token; only - is accepted, which reads it from stdin"),
        stringFlag("token-type", "private or bearer; default private"),
      ],
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const baseUrl = required(flags, "base-url", "the GitLab instance's root URL");
        const projectPath = required(flags, "project-path", "the GitLab project's full path");
        const token = await accessToken(flags, changed, false);
        const type = tokenType(flags);
        const body: GitlabLink = { baseUrl, projectPath };
        if (token !== undefined) body.accessToken = token;
        if (type !== undefined) body.tokenType = type;
        const created = await withProject(project(app), (id) => createGitlabIntegration(id, body));
        for (const line of integrationLines(created)) app.out.human(line);
        app.out.data(created);
      },
    },
    {
      name: "update",
      short: "Change the stored GitLab integration's settings",
      long:
        "Change the stored GitLab integration's settings; only what is passed changes.\n\n" +
        "The token, the GitLab URL and the project path stay as they are; linking a\n" +
        "different project is `connect` again.",
      args: noArgs("kaneo integration gitlab update"),
      flags: [
        boolFlag("active", "whether the integration is active"),
        boolFlag("comment-task-link", "comment a link back on each issue Kaneo opens in GitLab"),
      ],
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        nothingToChange(changed, ["active", "comment-task-link"]);
        const changes: GitlabLinkChanges = {};
        if (changed.has("active")) changes.isActive = flags.active === true;
        if (changed.has("comment-task-link"))
          changes.commentTaskLinkOnGitlabIssue = flags["comment-task-link"] === true;
        const updated = await withProject(project(app), (id) => updateGitlabIntegration(id, changes));
        for (const line of integrationLines(updated)) app.out.human(line);
        app.out.data(updated);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      short: "Unlink the project from GitLab",
      long:
        "Unlink the project from GitLab.\n\n" +
        "The stored token and webhook secret are removed with the link; a webhook\n" +
        "GitLab still calls answers as unknown.",
      args: noArgs("kaneo integration gitlab rm"),
      flags: [boolFlag("yes", "confirm the deletion")],
      run: async ({ flags, app }: RunContext<App>) => {
        apiKey(app);
        if (flags.yes !== true) {
          throw new Error(
            "refusing to unlink the GitLab integration without --yes; the stored token and webhook secret are removed with it",
          );
        }
        const result = await withProject(project(app), (id) => deleteGitlabIntegration(id));
        app.out.human(result.message);
        app.out.data(result);
      },
    },
    {
      name: "verify",
      short: "Check a GitLab token against a project without storing it",
      long:
        "Check that a GitLab token reaches a project with the permissions Kaneo\n" +
        "needs, without storing anything.\n\n" +
        "The answer is data rather than an error: a URL that is not a GitLab\n" +
        "instance, a redirect, or a project the token cannot see comes back in\n" +
        "the body with the check's findings, and the command exits 0. It fails\n" +
        "only when the request itself is refused — invalid input, or a token\n" +
        "GitLab rejects outright. --access-token takes only - and reads the\n" +
        "token from stdin.",
      args: noArgs("kaneo integration gitlab verify"),
      flags: [
        stringFlag("base-url", "root URL of the GitLab instance"),
        stringFlag("project-path", "full path of the GitLab project, nested groups included"),
        stringFlag("access-token", "GitLab access token; only - is accepted, which reads it from stdin"),
        stringFlag("token-type", "private or bearer; default private"),
      ],
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const baseUrl = required(flags, "base-url", "the GitLab instance's root URL");
        const projectPath = required(flags, "project-path", "the GitLab project's full path");
        // required above throws when the flag is absent, so this is a string.
        const token = (await accessToken(flags, changed, true))!;
        const type = tokenType(flags);
        const result = await withProject(project(app), (id) =>
          verifyGitlabAccess({
            projectId: id,
            baseUrl,
            accessToken: token,
            projectPath,
            ...(type === undefined ? {} : { tokenType: type }),
          }),
        );
        for (const line of verificationLines(result)) app.out.human(line);
        app.out.data(result);
      },
    },
    {
      name: "projects",
      short: "List the GitLab projects a token can see",
      long:
        "List the GitLab projects a token is a member of, to pick the one to link.\n\n" +
        "The token travels in the request body, never in the URL. --access-token\n" +
        "takes only - and reads it from stdin.",
      args: noArgs("kaneo integration gitlab projects"),
      flags: credentials,
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const baseUrl = required(flags, "base-url", "the GitLab instance's root URL");
        // required above throws when the flag is absent, so this is a string.
        const token = (await accessToken(flags, changed, true))!;
        const type = tokenType(flags);
        const projects = await withProject(project(app), (id) =>
          listGitlabProjects({
            projectId: id,
            baseUrl,
            accessToken: token,
            ...(type === undefined ? {} : { tokenType: type }),
          }),
        );
        for (const p of projects) app.out.human(projectLine(p));
        app.out.data(projects);
      },
    },
    {
      name: "import",
      short: "Import the linked project's open issues as tasks",
      long:
        "Import the linked GitLab project's open issues as tasks.\n\n" +
        "Issues that already have a task are refreshed rather than duplicated, and\n" +
        "confidential issues are skipped. The command exits non-zero when the server\n" +
        "reports errors for individual issues.",
      args: noArgs("kaneo integration gitlab import"),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const result = await withProject(project(app), (id) => importGitlabIssues(id));
        app.out.human(`imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped}`);
        for (const error of result.errors ?? []) app.out.status(`  ${error}`);
        app.out.data(result);
        if (result.errors !== undefined && result.errors.length > 0) {
          throw new Error(`${result.errors.length} issue${result.errors.length === 1 ? "" : "s"} failed to import`);
        }
      },
    },
  ],
};
