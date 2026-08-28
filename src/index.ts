#!/usr/bin/env bun
import { Command } from "commander";
import { registerWhoami } from "./commands/whoami";
import { registerTask } from "./commands/task";
import { registerProject } from "./commands/project";
import { registerWorkspace } from "./commands/workspace";
import { registerComment } from "./commands/comment";
import { registerActivity } from "./commands/activity";
import { registerSearch } from "./commands/search";
import { ConfigError } from "./config";
import { ApiError } from "./api/client";
import { TaskNotFoundError } from "./api/board";
import { log } from "./output";
import pkg from "../package.json";

const program = new Command();

program
  .name("kaneo")
  .description("CLI for Kaneo, the open source project management tool")
  .version(pkg.version)
  .option("--url <url>", "Kaneo instance URL (overrides KANEO_URL and config)")
  .option("--token <token>", "API token (overrides KANEO_TOKEN and config)")
  .option("--profile <name>", "config profile to use (overrides KANEO_PROFILE)")
  .option("--workspace <id>", "workspace id (overrides KANEO_WORKSPACE and config)")
  .option("--json", "output raw JSON to stdout");

registerWhoami(program);
registerTask(program);
registerProject(program);
registerWorkspace(program);
registerComment(program);
registerActivity(program);
registerSearch(program);

try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof ConfigError || e instanceof ApiError || e instanceof TaskNotFoundError) {
    log(`kaneo: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
