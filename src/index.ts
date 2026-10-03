#!/usr/bin/env bun
import { run } from "./cli/root";

process.exit(await run(process.argv.slice(2)));
