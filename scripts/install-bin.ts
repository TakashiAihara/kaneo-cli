#!/usr/bin/env bun
// ~/.local/bin/kaneo に symlink を張る。bun 前提の開発時インストール手段で、
// npm publish 後は `bun add -g` / `npm i -g` が正になる
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const target = resolve(import.meta.dir, "..", "src", "index.ts");
const binDir = join(homedir(), ".local", "bin");
const link = join(binDir, "kaneo");

mkdirSync(binDir, { recursive: true });
if (existsSync(link)) rmSync(link);
symlinkSync(target, link);
console.error(`installed: ${link} -> ${target}`);
