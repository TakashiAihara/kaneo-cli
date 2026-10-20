import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentRepo, parseRepo } from "../../src/config/repo";

const dirs: string[] = [];

// A global or system `url.<base>.insteadOf` would rewrite the origin before
// currentRepo reads it, so a row could pass without reaching the pattern it names.
const GIT_ENV = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME"] as const;
const savedEnv = new Map<string, string | undefined>();
let isolatedHome = "";

beforeAll(() => {
  for (const key of GIT_ENV) savedEnv.set(key, process.env[key]);
  isolatedHome = mkdtempSync(join(tmpdir(), "kaneo-home-"));
  const emptyConfig = join(isolatedHome, "gitconfig");
  writeFileSync(emptyConfig, "");
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = isolatedHome;
});

afterAll(() => {
  for (const key of GIT_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
});

const repoWithOrigin = (origin: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "kaneo-repo-"));
  dirs.push(dir);
  for (const args of [["init", "-q"], ["remote", "add", "origin", origin]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: dir });
    if (!git.success) throw new Error(`git ${args.join(" ")} failed`);
  }
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("currentRepo", () => {
  test.each([
    ["git@github.com:acme/thing.git", "acme/thing"],
    ["github.com:acme/thing", "acme/thing"],
    ["github.com:acme/thing.git", "acme/thing"],
    ["gh:acme/thing.git", "acme/thing"],
    ["host:/acme/thing", "acme/thing"],
    ["https://github.com/acme/thing.git", "acme/thing"],
  ])("reads %s as %s", (origin, expected) => {
    expect(currentRepo(repoWithOrigin(origin))).toBe(expected);
  });

  test.each(["C:x/y", "/home/me/acme/thing", "./acme/thing", "host:thing"])("does not read %s as a repository", (origin) => {
    expect(currentRepo(repoWithOrigin(origin))).toBe("");
  });
});

describe("parseRepo", () => {
  test("still refuses a typed user-less scp form", () => {
    expect(parseRepo("github.com:acme/thing")).toBe("");
  });

  test("takes owner/name", () => {
    expect(parseRepo("acme/thing")).toBe("acme/thing");
  });
});
