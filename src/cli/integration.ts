import { gitlabCommand } from "./integration-gitlab";
import { githubCommand } from "./integration-github";

// The integrations a project can have, one node per provider so each
// provider's commands live in their own file and share the same verbs:
// get, connect, update, rm, verify, repos, import.
export const integrationCommand = {
  name: "integration",
  aliases: ["integrations"],
  short: "Work with the project's integrations",
  children: [gitlabCommand, githubCommand],
};
