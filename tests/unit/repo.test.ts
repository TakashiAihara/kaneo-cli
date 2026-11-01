import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentRepo, parseRepo } from "../../src/config/repo";

const dirs: string[] = [];

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// A global or system `url.<base>.insteadOf` would rewrite the origin before
// currentRepo reads it, so a row could pass without reaching the pattern it names.
// Only PATH is inherited: a GIT_DIR from a git hook would point the temp repo's
// git init and remote add at another repository.
const isolatedEnv = (globalConfig = ""): Record<string, string | undefined> => {
  const home = tempDir("kaneo-home-");
  const config = join(home, "gitconfig");
  writeFileSync(config, globalConfig);
  return { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", HOME: home };
};

const repoWithOrigin = (origin: string, env: Record<string, string | undefined>): string => {
  const dir = tempDir("kaneo-repo-");
  for (const args of [["init", "-q"], ["remote", "add", "origin", origin]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: dir, env });
    if (!git.success) throw new Error(`git ${args.join(" ")} failed`);
  }
  return dir;
};

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("currentRepo", () => {
  test.each([
    ["git@github.com:acme/thing.git", "acme/thing"],
    ["github.com:acme/thing", "acme/thing"],
    ["github.com:acme/thing.git", "acme/thing"],
    ["gh:acme/thing.git", "acme/thing"],
    ["host:/acme/thing", "acme/thing"],
    ["host:~acme/thing", "~acme/thing"],
    ["https://git.sr.ht/~acme/thing", "~acme/thing"],
    ["host:acme/thing.git.git", "acme/thing.git"],
    ["https://github.com/acme/thing.git", "acme/thing"],
  ])("reads %s as %s", (origin, expected) => {
    const env = isolatedEnv();
    expect(currentRepo(repoWithOrigin(origin, env), env)).toBe(expected);
  });

  test.each(["C:x/y", "C:/x/y", "/home/me/acme/thing", "./acme/thing", "./foo:acme/thing", "/srv/x:acme/thing", "host:thing", "host:../x", "host:acme/..", "git@host:../x", "ssh://host/../x"])(
    "does not read %s as a repository",
    (origin) => {
      const env = isolatedEnv();
      expect(currentRepo(repoWithOrigin(origin, env), env)).toBe("");
    },
  );

  test("runs git with the env it is given", () => {
    const env = isolatedEnv('[url "git@github.com:other/"]\n\tinsteadOf = host:acme/\n');
    expect(currentRepo(repoWithOrigin("host:acme/thing", env), env)).toBe("other/thing");
  });
});

describe("parseRepo", () => {
  test("takes a user-less scp form, as the origin remote is read", () => {
    expect(parseRepo("github.com:acme/thing.git")).toBe("acme/thing");
  });

  test.each(["host:../x", "acme/..", "acme/.", "C:x/y"])("refuses %s", (value) => {
    expect(parseRepo(value)).toBe("");
  });

  test("takes owner/name", () => {
    expect(parseRepo("acme/thing")).toBe("acme/thing");
  });

  test("strips one .git, as the remote forms do", () => {
    expect(parseRepo("acme/thing.git.git")).toBe("acme/thing.git");
  });
});
