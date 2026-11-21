import { apiKey, project, type App } from "./app";
import {
  connectGitHubRepository,
  deleteGitHubIntegration,
  getGitHubIntegration,
  githubAppInfo,
  importGitHubIssues,
  listGitHubRepositories,
  updateGitHubIntegration,
  verifyGitHubRepository,
  type GitHubIntegration,
} from "../api/kaneo";
import { exactArgs, noArgs, type FlagValues } from "./args";
import { withProject } from "./lookup";

// owner and name are each a GitHub path segment the server checks against the
// installation. Blank is refused here, as is the 100 characters the request
// schemas cap them at, so a malformed body never costs a request.
const repoPart = (value: string, what: string): string => {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${what} cannot be blank`);
  if (trimmed.length > 100) throw new Error(`${what} is longer than 100 characters`);
  return trimmed;
};

const repoRef = (args: string[]): [string, string] => [
  repoPart(args[0]!, "repository owner"),
  repoPart(args[1]!, "repository name"),
];

// The pages the repositories route takes are strings on the wire — "1" to
// "999999" — the bound its pattern gives them.
const PAGE = /^[1-9][0-9]{0,5}$/;
const pageArg = (flags: FlagValues, changed: ReadonlySet<string>, name: string): string | undefined => {
  if (!changed.has(name)) return undefined;
  const value = String(flags[name] ?? "");
  if (!PAGE.test(value)) throw new Error(`--${name} must be a page number from 1 to 999999`);
  return value;
};

// A run id is the server's own token, resumed as it was issued: non-empty and
// within the 128 characters the request schema allows.
const runIdArg = (flags: FlagValues, changed: ReadonlySet<string>): string | undefined => {
  if (!changed.has("run-id")) return undefined;
  const runId = String(flags["run-id"] ?? "");
  if (runId === "") throw new Error("empty --run-id");
  if (runId.length > 128) throw new Error("--run-id is longer than 128 characters");
  return runId;
};

// The integration as a person reads it, aligned like the whoami lines. The
// import progress is left to --json when there is no run: an absent one is the
// ordinary state, not news.
const integrationLines = (i: GitHubIntegration): string[] => {
  const lines = [
    `repository   ${i.repositoryOwner}/${i.repositoryName}`,
    `active       ${i.isActive === true ? "yes" : i.isActive === false ? "no" : "unknown"}`,
    `verified     ${i.requiresVerification ? "no" : "yes"}`,
    `installation ${i.installationId ?? "none"}`,
    // The server defaults the flag on, so only an explicit false reads off.
    `comments     ${i.commentTaskLinkOnGitHubIssue === false ? "off" : "on"}`,
  ];
  if (i.branchPattern !== null) lines.push(`branches     ${i.branchPattern}`);
  if (i.importProgress !== null) {
    const p = i.importProgress;
    lines.push(
      `import       ${p.imported} imported, ${p.updated} updated, ${p.skipped} skipped${p.pending ? " (in progress)" : ""}`,
    );
  }
  return lines;
};

const printIntegration = (app: App, i: GitHubIntegration): void => {
  for (const line of integrationLines(i)) app.out.human(line);
};

export const githubCommand = {
  name: "github",
  aliases: ["gh"],
  short: "Work with the project's GitHub integration",
  children: [
    {
      name: "app-info",
      short: "Show the GitHub App this instance is configured with",
      args: noArgs("kaneo integration github app-info"),
      run: async ({ app }: { app: App }) => {
        apiKey(app);
        const info = await githubAppInfo();
        app.out.human(`app       ${info.appName ?? "not configured"}`);
        app.out.human(`account   ${info.accountConnected ? "connected" : "not connected"}`);
        app.out.human(`linking   ${info.accountLinkingAvailable ? "available" : "unavailable"}`);
        app.out.data(info);
      },
    },
    {
      name: "repos",
      short: "List the repositories the GitHub App can reach, one page at a time",
      long:
        "List the repositories the GitHub App can reach, one page at a time.\n\n" +
        "The server pages installations and each installation's repositories\n" +
        "separately. When the reply carries a nextPage, pass its two numbers back\n" +
        "as --installation-page and --repository-page for the following page.",
      args: noArgs("kaneo integration github repos"),
      flags: [
        { name: "installation-page", type: "string" as const, usage: "installation page to read", defaultValue: "" },
        {
          name: "repository-page",
          type: "string" as const,
          usage: "repository page within each installation to read",
          defaultValue: "",
        },
      ],
      run: async ({ flags, changed, app }: { flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        apiKey(app);
        const installationPage = pageArg(flags, changed, "installation-page");
        const repositoryPage = pageArg(flags, changed, "repository-page");
        const result = await withProject(project(app), (id) =>
          listGitHubRepositories(id, {
            ...(installationPage === undefined ? {} : { installationPage }),
            ...(repositoryPage === undefined ? {} : { repositoryPage }),
          }),
        );
        for (const installation of result.installations) {
          const account =
            installation.account === null
              ? "an unknown account"
              : `${installation.account.login} (${installation.account.type})`;
          const count = installation.repositories.length;
          app.out.human(
            `installation ${installation.id}  ${account}  ${count} ${count === 1 ? "repository" : "repositories"}`,
          );
        }
        for (const repo of result.repositories) {
          app.out.human(
            `${repo.full_name}  ${repo.private ? "private" : "public"}  ${repo.owner.login}  ${repo.updated_at}`,
          );
        }
        if (result.nextPage !== null) {
          app.out.status(
            `more repositories: kaneo integration github repos --installation-page ${result.nextPage.installationPage} --repository-page ${result.nextPage.repositoryPage}`,
          );
        }
        app.out.data(result);
      },
    },
    {
      name: "verify",
      use: "verify <owner> <repo>",
      short: "Check the App's installation and permissions on a repository",
      long:
        "Check the App's installation and permissions on a repository.\n\n" +
        "The answer is data rather than an error: a repository the App cannot\n" +
        "reach comes back with isInstalled false and a message saying what to do,\n" +
        "along with the URLs to install or adjust the App when there are any.",
      args: exactArgs(2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        const [owner, name] = repoRef(args);
        apiKey(app);
        const result = await withProject(project(app), (id) => verifyGitHubRepository(id, owner, name));
        // The facts lead so an empty server message cannot hide them: the
        // message is the server's own summary of the same answer.
        app.out.human(`installed    ${result.isInstalled ? "yes" : "no"}`);
        if (result.isInstalled) {
          app.out.human(
            result.hasRequiredPermissions
              ? "permissions  complete"
              : result.missingPermissions.length === 0
                ? "permissions  incomplete"
                : `permissions  missing: ${result.missingPermissions.join(", ")}`,
          );
        }
        if (result.message !== "") app.out.human(result.message);
        if (result.installationUrl !== null) app.out.human(`install   ${result.installationUrl}`);
        if (result.settingsUrl !== null) app.out.human(`settings  ${result.settingsUrl}`);
        app.out.data(result);
      },
    },
    {
      name: "get",
      short: "Show the project's GitHub integration",
      args: noArgs("kaneo integration github get"),
      run: async ({ app }: { app: App }) => {
        apiKey(app);
        const integration = await withProject(project(app), (id) => getGitHubIntegration(id));
        if (integration === null) {
          app.out.human("no GitHub integration; `kaneo integration github connect <owner> <repo>` links one");
          app.out.data(null);
          return;
        }
        printIntegration(app, integration);
        app.out.data(integration);
      },
    },
    {
      name: "connect",
      use: "connect <owner> <repo>",
      short: "Link the project to a GitHub repository",
      long:
        "Link the project to a GitHub repository.\n\n" +
        "The server verifies the repository is reachable through an App\n" +
        "installation the caller administers, answers the existing integration\n" +
        "when the same repository is already linked, and refuses a different one\n" +
        "with 409 — `kaneo integration github rm` disconnects first.",
      args: exactArgs(2),
      run: async ({ args, app }: { args: string[]; app: App }) => {
        const [owner, name] = repoRef(args);
        apiKey(app);
        const integration = await withProject(project(app), (id) => connectGitHubRepository(id, owner, name));
        app.out.human(`connected ${integration.repositoryOwner}/${integration.repositoryName}`);
        printIntegration(app, integration);
        app.out.data(integration);
      },
    },
    {
      name: "update",
      short: "Change the GitHub integration's settings",
      args: noArgs("kaneo integration github update"),
      flags: [
        {
          name: "active",
          type: "bool" as const,
          usage: "whether issue and pull request sync runs (--active=false pauses it)",
          defaultValue: "false",
        },
        {
          name: "comment-task-link",
          type: "bool" as const,
          usage: "comment a link back to the task on the GitHub issue (--comment-task-link=false turns it off)",
          defaultValue: "false",
        },
      ],
      run: async ({ flags, changed, app }: { flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        apiKey(app);
        const changes: { isActive?: boolean; commentTaskLinkOnGitHubIssue?: boolean } = {};
        if (changed.has("active")) changes.isActive = flags.active === true;
        if (changed.has("comment-task-link"))
          changes.commentTaskLinkOnGitHubIssue = flags["comment-task-link"] === true;
        if (changes.isActive === undefined && changes.commentTaskLinkOnGitHubIssue === undefined) {
          throw new Error("nothing to change: pass --active or --comment-task-link");
        }
        const integration = await withProject(project(app), (id) => updateGitHubIntegration(id, changes));
        app.out.human("updated GitHub integration");
        printIntegration(app, integration);
        app.out.data(integration);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      short: "Disconnect the project from its GitHub repository",
      args: noArgs("kaneo integration github rm"),
      flags: [{ name: "yes", type: "bool" as const, usage: "confirm the deletion", defaultValue: "false" }],
      run: async ({ flags, app }: { flags: FlagValues; app: App }) => {
        apiKey(app);
        // The unlink cannot be undone from here: issue and pull request sync
        // stops, and linking a different repository means connecting again.
        if (flags.yes !== true) {
          throw new Error(
            "refusing to delete the GitHub integration without --yes; the project is unlinked from its repository",
          );
        }
        const deleted = await withProject(project(app), (id) => deleteGitHubIntegration(id));
        app.out.human("deleted GitHub integration");
        app.out.data(deleted);
      },
    },
    {
      name: "import",
      short: "Import the repository's issues as tasks, resuming until done",
      long:
        "Import the repository's issues as tasks, resuming until done.\n\n" +
        "The server works the repository in pages and answers 202 while pages\n" +
        "remain; each answer names a runId the next request continues. A call\n" +
        "without --run-id resumes an unfinished run or starts a new one, so a\n" +
        "repeated or interrupted call picks up where it stopped.",
      args: noArgs("kaneo integration github import"),
      flags: [
        {
          name: "run-id",
          type: "string" as const,
          usage: "resume a specific import run rather than the latest",
          defaultValue: "",
        },
      ],
      run: async ({ flags, changed, app }: { flags: FlagValues; changed: ReadonlySet<string>; app: App }) => {
        apiKey(app);
        const runId = runIdArg(flags, changed);
        const result = await withProject(project(app), (id) => importGitHubIssues(id, runId));
        app.out.human(
          `import ${result.runId}: ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped`,
        );
        app.out.data(result);
      },
    },
  ],
};
