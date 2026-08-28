#!/usr/bin/env bun
import { Command } from "commander";
import { registerWhoami } from "./commands/whoami";
import { ConfigError } from "./config";
import { ApiError } from "./api/client";
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
  .option("--json", "output raw JSON to stdout");

registerWhoami(program);

try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof ConfigError || e instanceof ApiError) {
    log(`kaneo: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
