import type { App } from "./app";
import type { Command } from "./args";
import { discordCommand } from "./integration-discord";
import { giteaCommand } from "./integration-gitea";
import { githubCommand } from "./integration-github";
import { gitlabCommand } from "./integration-gitlab";
import { mattermostCommand } from "./integration-mattermost";
import { slackCommand } from "./integration-slack";
import { telegramCommand } from "./integration-telegram";
import { webhookCommand } from "./integration-webhook";

// One node per provider: each command in integration-gitea.ts,
// integration-gitlab.ts, integration-github.ts, integration-mattermost.ts,
// integration-webhook.ts, integration-slack.ts, integration-discord.ts and
// integration-telegram.ts carries its own verbs.
export const integrationCommand: Command<App> = {
  name: "integration",
  aliases: ["integrations"],
  short: "Work with the project's integrations",
  long:
    "The integrations a project can have: Mattermost posts task events to an\n" +
    "incoming webhook, webhook POSTs them to any HTTP endpoint, slack,\n" +
    "discord and telegram post them to chat, gitlab links the project to a\n" +
    "GitLab project, github links it to a GitHub repository, and gitea links\n" +
    "it to a Gitea repository.\n\n" +
    "Mattermost, webhook, slack, discord and telegram have get, set and rm;\n" +
    "`set` creates the integration when the project has none and changes it\n" +
    "when it does. Gitlab's verbs are its own: get, connect, update, rm,\n" +
    "verify, projects and import; gitea's match them with repos for projects.\n" +
    "GitHub's verbs are app-info, repos, verify, get, connect, update, rm\n" +
    "and import.",
  children: [
    giteaCommand,
    gitlabCommand,
    githubCommand,
    mattermostCommand,
    webhookCommand,
    slackCommand,
    discordCommand,
    telegramCommand,
  ],
};
