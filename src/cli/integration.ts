import type { App } from "./app";
import type { Command } from "./args";
import { gitlabCommand } from "./integration-gitlab";
import { githubCommand } from "./integration-github";
import { mattermostCommand } from "./integration-mattermost";
import { webhookCommand } from "./integration-webhook";

// One node per provider: each command in integration-gitlab.ts,
// integration-github.ts, integration-mattermost.ts and
// integration-webhook.ts carries its own verbs.
export const integrationCommand: Command<App> = {
  name: "integration",
  aliases: ["integrations"],
  short: "Work with the project's integrations",
  long:
    "The integrations a project can have: Mattermost posts task events to an\n" +
    "incoming webhook, webhook POSTs them to any HTTP endpoint, gitlab\n" +
    "links the project to a GitLab project, and github links it to a GitHub\n" +
    "repository.\n\n" +
    "Mattermost and webhook have get, set and rm; `set` creates the\n" +
    "integration when the project has none and changes it when it does.\n" +
    "Gitlab's verbs are its own: get, connect, update, rm, verify, projects\n" +
    "and import. GitHub's verbs are app-info, repos, verify, get, connect,\n" +
    "update, rm and import.",
  children: [gitlabCommand, githubCommand, mattermostCommand, webhookCommand],
};
