import { apiKey, project, type App } from "./app";
import {
  createGiteaIntegration,
  deleteGiteaIntegration,
  getGiteaIntegration,
  importGiteaIssues,
  listGiteaRepositories,
  updateGiteaIntegration,
  verifyGiteaAccess,
  type GiteaIntegration,
  type GiteaIntegrationChanges,
  type GiteaTarget,
} from "../api/kaneo";
import { exactArgs, noArgs, type FlagValues, type RunContext } from "./args";
import { readInput } from "./input";
import { withProject } from "./lookup";
import type { Json } from "../output/json";

// A Gitea repository is written owner/name everywhere it appears — in the API,
// in a URL path and in what connect takes — so that is the one form this
// command asks for rather than teaching two arguments.
const repository = (arg: string): Pick<GiteaTarget, "repositoryOwner" | "repositoryName"> => {
  const trimmed = arg.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.indexOf("/", slash + 1) !== -1) {
    throw new Error(`give the repository as <owner>/<name>, not ${JSON.stringify(arg)}`);
  }
  return { repositoryOwner: trimmed.slice(0, slash), repositoryName: trimmed.slice(slash + 1) };
};

// A Gitea access token is a credential: as a flag value it sits in the process
// list and the shell history, so --token takes only `-`, which reads the token
// from stdin — the same way a description is piped in. Stdin is one stream, so
// one flag asks for it per command; these commands have at most one.
const accessToken = async (flags: FlagValues, changed: ReadonlySet<string>): Promise<string | undefined> => {
  if (!changed.has("token")) return undefined;
  if (String(flags.token ?? "") !== "-") {
    throw new Error(
      "a Gitea access token as a flag value is visible in the process list and shell history; pass --token - and pipe it instead",
    );
  }
  // The one line ending a pipe adds is not part of the token.
  const token = (await readInput("-")).replace(/\r?\n$/, "");
  if (token === "") throw new Error("empty access token on stdin");
  return token;
};

// --base-url is required by every command that talks to the instance; an empty
// value is refused here rather than sent for the server to reject.
const baseUrl = (flags: FlagValues): string => {
  const url = String(flags["base-url"] ?? "").trim();
  if (url === "") throw new Error("no Gitea instance: pass --base-url <url>");
  return url;
};

// The fields of a stored integration a person needs, one per line under the
// command's own summary. webhookSecret is printed only when the server sent it
// — it goes only to a caller holding workspace:manage_settings, and it is the
// value pasted into the webhook Gitea posts to, so showing it is the point.
const detail = (label: string, value: string | null): string => `  ${label.padEnd(15)}${value ?? ""}`;

const integrationLines = (i: GiteaIntegration): string[] => [
  detail("instance", i.baseUrl),
  detail("repository", `${i.repositoryOwner}/${i.repositoryName}`),
  detail("token", i.maskedAccessToken),
  ...(i.webhookUrl === null ? [] : [detail("webhook", i.webhookUrl)]),
  ...(i.webhookSecret === null || i.webhookSecret === "" ? [] : [detail("webhook secret", i.webhookSecret)]),
  ...(i.branchPattern === null || i.branchPattern === "" ? [] : [detail("branches", i.branchPattern)]),
  detail("state", i.isActive === null ? "unknown" : i.isActive ? "active" : "inactive"),
  detail(
    "issue links",
    i.commentTaskLinkOnGiteaIssue === null ? "unknown" : i.commentTaskLinkOnGiteaIssue ? "on" : "off",
  ),
];

const boolFlag = (name: string, usage: string) => ({ name, type: "bool" as const, usage, defaultValue: "false" });
const stringFlag = (name: string, usage: string) => ({ name, type: "string" as const, usage, defaultValue: "" });

// The flags every command that reaches the instance shares. --token is
// optional where the server can fall back on the stored token (verify with a
// matching base URL, connect keeping the stored one); repos has no fallback
// and insists on it.
const TARGET_FLAGS = [
  stringFlag("base-url", "the Gitea instance's URL, e.g. https://gitea.example.com"),
  stringFlag("token", "the Gitea access token; only - is accepted, which reads it from stdin"),
];

// What connect and verify send: the repository split out of its owner/name
// form, the instance, and the token only when one was piped in — omitting it
// is how the server is asked to use the stored one. The argument and
// --base-url are refused before stdin is read, so a command that cannot run
// does not consume the pipe first.
const target = async (arg: string, flags: FlagValues, changed: ReadonlySet<string>): Promise<GiteaTarget> => {
  const repo = repository(arg);
  const url = baseUrl(flags);
  const token = await accessToken(flags, changed);
  return {
    ...repo,
    baseUrl: url,
    ...(token === undefined ? {} : { accessToken: token }),
  };
};

export const giteaCommand = {
  name: "gitea",
  short: "Link a project to a Gitea repository",
  long:
    "Link a project to a Gitea repository.\n\n" +
    "The project is the one -p, KANEO_PROJECT or the repository's config names,\n" +
    "the same as every other project command. A Gitea access token is a\n" +
    "credential, so it is never a flag value: --token - reads it from stdin,\n" +
    "less the one line ending the pipe adds.\n\n" +
    "connect and verify may leave --token out when the project already has an\n" +
    "integration on the same instance: the server then uses the stored token.\n" +
    "A token is never sent to a different base URL.",
  children: [
    {
      name: "get",
      short: "Show the project's Gitea integration",
      args: noArgs("kaneo integration gitea get"),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const found = await withProject(project(app), (id) => getGiteaIntegration(id));
        if (found === null) {
          app.out.human("no gitea integration for this project");
        } else {
          app.out.human(`${found.repositoryOwner}/${found.repositoryName} on ${found.baseUrl}`);
          for (const line of integrationLines(found)) app.out.human(line);
        }
        app.out.data(found as Json);
      },
    },
    {
      name: "connect",
      use: "connect <owner>/<name>",
      short: "Link the project to a Gitea repository",
      long:
        "Link the project to a Gitea repository, or link it again to move it.\n\n" +
        "The server checks the token reaches the repository before storing the\n" +
        "link, and answers with the integration it saved — including the webhook\n" +
        "URL Gitea should post events to, and its secret when the key may see it.\n\n" +
        "--token may be left out to keep the stored token, which only works while\n" +
        "the base URL is the saved integration's; a new instance needs a token,\n" +
        "a different repository on the same instance does not. Connecting again\n" +
        "is how the link is moved — update only changes the two settings.",
      args: exactArgs(1),
      flags: TARGET_FLAGS,
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const wanted = await target(args[0]!, flags, changed);
        const created = await withProject(project(app), (id) => createGiteaIntegration(id, wanted));
        app.out.human(`connected ${created.repositoryOwner}/${created.repositoryName} on ${created.baseUrl}`);
        for (const line of integrationLines(created)) app.out.human(line);
        app.out.data(created as Json);
      },
    },
    {
      name: "update",
      short: "Change the project's Gitea integration settings",
      long:
        "Change the project's Gitea integration settings; only what is passed changes.\n\n" +
        "The instance, repository and token are not settings here: connect again\n" +
        "with a different one to move the link. --active=false stops Kaneo\n" +
        "handling the integration's events and issue imports without unlinking\n" +
        "it; --comment-task-link=false stops Kaneo commenting a link back to the\n" +
        "task on each Gitea issue.",
      args: noArgs("kaneo integration gitea update"),
      flags: [
        boolFlag("active", "whether Kaneo handles this integration (=false turns it off)"),
        boolFlag("comment-task-link", "comment a link back to the task on each Gitea issue (=false turns it off)"),
      ],
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const changes: GiteaIntegrationChanges = {};
        if (changed.has("active")) changes.isActive = flags.active === true;
        if (changed.has("comment-task-link")) changes.commentTaskLinkOnGiteaIssue = flags["comment-task-link"] === true;
        if (Object.keys(changes).length === 0) {
          throw new Error("nothing to change: pass --active or --comment-task-link");
        }
        const updated = await withProject(project(app), (id) => updateGiteaIntegration(id, changes));
        app.out.human(`updated ${updated.repositoryOwner}/${updated.repositoryName} on ${updated.baseUrl}`);
        for (const line of integrationLines(updated)) app.out.human(line);
        app.out.data(updated as Json);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      short: "Unlink the project from its Gitea repository",
      long:
        "Unlink the project from its Gitea repository.\n\n" +
        "The integration row and its webhook secret go with it; connecting again\n" +
        "makes a new link. Tasks already imported stay on the board, but the\n" +
        "external links they hold through this integration are deleted with it.",
      args: noArgs("kaneo integration gitea rm"),
      flags: [boolFlag("yes", "confirm the deletion")],
      run: async ({ flags, app }: RunContext<App>) => {
        apiKey(app);
        const { found, result } = await withProject(project(app), async (id) => {
          const current = await getGiteaIntegration(id);
          if (current === null) throw new Error("this project has no gitea integration to delete");
          if (flags.yes !== true) {
            throw new Error(
              `refusing to delete the gitea integration of ${current.repositoryOwner}/${current.repositoryName} on ${current.baseUrl} without --yes`,
            );
          }
          return { found: current, result: await deleteGiteaIntegration(id) };
        });
        app.out.human(
          `deleted the gitea integration of ${found.repositoryOwner}/${found.repositoryName} on ${found.baseUrl}`,
        );
        app.out.data(result);
      },
    },
    {
      name: "verify",
      use: "verify <owner>/<name>",
      short: "Check a Gitea instance, token and repository without linking",
      long:
        "Check a Gitea instance, token and repository without linking the project.\n\n" +
        "Nothing is stored: the answer says whether the URL is a Gitea instance,\n" +
        "whether the token has the permissions issue sync needs, and whether the\n" +
        "repository exists — each as a field rather than a failure, so a bad URL\n" +
        "or a missing permission is reported, not thrown. --token may be left out\n" +
        "to verify with the stored token, which the server does only when the\n" +
        "base URL is the saved integration's.",
      args: exactArgs(1),
      flags: TARGET_FLAGS,
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const wanted = await target(args[0]!, flags, changed);
        const checked = await withProject(project(app), (id) => verifyGiteaAccess({ projectId: id, ...wanted }));
        app.out.human(checked.message);
        if (checked.missingPermissions.length > 0) {
          app.out.human(`  missing permissions: ${checked.missingPermissions.join(", ")}`);
        }
        if (checked.failureReason !== null) app.out.human(`  failure reason: ${checked.failureReason}`);
        app.out.data(checked as Json);
      },
    },
    {
      name: "repos",
      short: "List the repositories the Gitea token can reach",
      long:
        "List the repositories the Gitea token can reach on the instance, for\n" +
        "picking one to connect. The token is required: unlike verify and\n" +
        "connect, this route has no stored-token fallback.",
      args: noArgs("kaneo integration gitea repos"),
      flags: TARGET_FLAGS,
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        const url = baseUrl(flags);
        const token = await accessToken(flags, changed);
        if (token === undefined) throw new Error("repos needs the token: pass --token - and pipe it");
        const repos = await withProject(project(app), (id) =>
          listGiteaRepositories({ projectId: id, baseUrl: url, accessToken: token }),
        );
        // fullName is the owner/name connect takes, so a line can be picked and
        // passed on as it is.
        for (const r of repos) app.out.human(`${r.fullName}  ${r.private ? "private" : "public"}  ${r.htmlUrl}`);
        app.out.data(repos as Json);
      },
    },
    {
      name: "import",
      short: "Import the linked repository's open issues as tasks",
      long:
        "Import the linked repository's open issues as tasks.\n\n" +
        "Only open issues become tasks; pull requests are skipped. An issue that\n" +
        "already has a task is refreshed rather than duplicated. Issues that\n" +
        "could not be imported are listed and the command exits non-zero when\n" +
        "any failed. The integration must exist and be active.",
      args: noArgs("kaneo integration gitea import"),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const result = await withProject(project(app), (id) => importGiteaIssues(id));
        for (const e of result.errors) app.out.human(e);
        app.out.human(`imported ${result.imported} issue(s), updated ${result.updated}, skipped ${result.skipped}`);
        app.out.data(result as Json);
        if (result.errors.length > 0) throw new Error(`${result.errors.length} issue(s) could not be imported`);
      },
    },
  ],
};
