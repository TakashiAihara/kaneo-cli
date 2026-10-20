import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentRepo, parseRepo } from "../../src/config/repo";

const dirs: string[] = [];

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
    ["https://github.com/acme/thing.git", "acme/thing"],
  ])("reads %s as %s", (origin, expected) => {
    expect(currentRepo(repoWithOrigin(origin))).toBe(expected);
  });

  test.each(["C:x/y", "C:/x/y", "/home/me/acme/thing", "./acme/thing", "host:thing"])("does not read %s as a repository", (origin) => {
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
