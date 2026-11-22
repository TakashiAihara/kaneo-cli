import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// scripts/rebase-main.ts rewrites history and force-pushes, so the tests run
// it end to end against scratch repositories: a bare "origin" and working
// clones. The script is committed into the fixture like any other file —
// that is also what puts it at <repo>/scripts/, where its root resolution
// expects it. The rebuild steps are stubbed by a minimal package.json so a
// run stays offline and fast.

const GIT_ENV = {
  ...process.env,
  GIT_EDITOR: "true",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

const must = (cwd: string, args: string[]): string => {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err.trim()}`);
  return r.out.trim();
};

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

const SCRIPT = join(import.meta.dir, "../scripts/rebase-main.ts");

const put = (dir: string, path: string, body: string) => {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
};

// The files the rebuild steps need, committed so the tree stays clean: a
// package.json whose generate/typecheck are no-ops, a record-golden stub, one
// passing test for `bun test`, and the script itself. `bun install` runs once
// here so the script's --frozen-lockfile has a lockfile to check.
const scaffold = (dir: string) => {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "scratch",
      private: true,
      scripts: { generate: "true", typecheck: "true" },
    }) + "\n",
  );
  writeFileSync(join(dir, "scripts/record-golden.ts"), 'console.log("record-golden stub");\n');
  writeFileSync(
    join(dir, "smoke.test.ts"),
    'import { expect, test } from "bun:test";\n\ntest("smoke", () => {\n  expect(1).toBe(1);\n});\n',
  );
  cpSync(SCRIPT, join(dir, "scripts/rebase-main.ts"));
  // The script stages both generated trees after the rebuild; git add fails
  // on a pathspec that matches nothing, so the golden dir needs a file.
  put(dir, "tests/parity/golden/keep.txt", "golden\n");
  const inst = Bun.spawnSync(["bun", "install"], { cwd: dir, env: GIT_ENV });
  if (inst.exitCode !== 0) throw new Error(`bun install: ${inst.stderr.toString()}`);
};

const run = (work: string) => {
  const p = Bun.spawnSync(["bun", "scripts/rebase-main.ts"], {
    cwd: work,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

// A repo whose main holds the scaffold plus src/api/gen/g.txt = "base",
// pushed to a bare origin.
const seedRemote = (root: string): { remote: string; work: string } => {
  const remote = join(root, "origin.git");
  must(root, ["init", "--bare", "-b", "main", remote]);
  const work = join(root, "work");
  mkdirSync(work);
  must(work, ["init", "-b", "main"]);
  scaffold(work);
  put(work, "src/api/gen/g.txt", "base\n");
  must(work, ["add", "-A"]);
  must(work, ["commit", "-m", "base"]);
  must(work, ["remote", "add", "origin", remote]);
  must(work, ["push", "-u", "origin", "main"]);
  return { remote, work };
};

const remoteTip = (work: string, branch: string): string =>
  must(work, ["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s+/)[0]!;

describe("rebase-main", () => {
  test("a fresh run squashes, resolves generated conflicts, and pushes a new branch", () => {
    const root = scratch("rebase-main-fresh-");
    const { work } = seedRemote(root);

    // Two commits that both rewrite the generated file, plus a normal file
    // each so neither becomes empty once g.txt takes main's side. feat is
    // never pushed, so the remote has no such branch.
    must(work, ["checkout", "-b", "feat"]);
    put(work, "src/api/gen/g.txt", "feat-one\n");
    put(work, "f1.txt", "one\n");
    must(work, ["add", "-A"]);
    must(work, ["commit", "-m", "feat one"]);
    put(work, "src/api/gen/g.txt", "feat-two\n");
    put(work, "f2.txt", "two\n");
    must(work, ["add", "-A"]);
    must(work, ["commit", "-m", "feat two"]);

    must(work, ["checkout", "main"]);
    put(work, "src/api/gen/g.txt", "main-one\n");
    must(work, ["add", "-A"]);
    must(work, ["commit", "-m", "main one"]);
    must(work, ["push", "origin", "main"]);
    must(work, ["fetch", "origin"]);
    must(work, ["checkout", "feat"]);

    const r = run(work);
    expect(r.code).toBe(0);

    // The two commits were squashed into one before the rebase.
    expect(must(work, ["rev-list", "--count", "origin/main..HEAD"])).toBe("1");
    expect(must(work, ["show", "HEAD:src/api/gen/g.txt"])).toBe("main-one");
    expect(must(work, ["show", "HEAD:f1.txt"])).toBe("one");
    expect(must(work, ["show", "HEAD:f2.txt"])).toBe("two");
    expect(remoteTip(work, "feat")).toBe(must(work, ["rev-parse", "HEAD"]));
  });

  test("a resumed rebase resolves consecutive generated-path conflicts and pushes", () => {
    const root = scratch("rebase-main-resume-");
    const { work } = seedRemote(root);

    must(work, ["checkout", "-b", "feat"]);
    put(work, "src/api/gen/g.txt", "feat-one\n");
    put(work, "f1.txt", "one\n");
    must(work, ["add", "-A"]);
    must(work, ["commit", "-m", "feat one"]);
    put(work, "src/api/gen/g.txt", "feat-two\n");
    put(work, "f2.txt", "two\n");
    must(work, ["add", "-A"]);
    must(work, ["commit", "-m", "feat two"]);
    must(work, ["push", "-u", "origin", "feat"]);

    must(work, ["checkout", "main"]);
    put(work, "src/api/gen/g.txt", "main-one\n");
    must(work, ["add", "-A"]);
    must(work, ["commit", "-m", "main one"]);
    must(work, ["push", "origin", "main"]);
    must(work, ["fetch", "origin"]);

    must(work, ["checkout", "feat"]);
    // The rebase stops on the first commit's generated-path conflict and is
    // left for the script to resume, the way an interrupted run leaves it.
    const reb = git(work, ["rebase", "origin/main"]);
    expect(reb.code).not.toBe(0);

    const r = run(work);
    expect(r.code).toBe(0);

    // Both commits survived the replay and the generated file took main's
    // side at every stop.
    expect(must(work, ["rev-list", "--count", "origin/main..HEAD"])).toBe("2");
    expect(must(work, ["show", "HEAD:src/api/gen/g.txt"])).toBe("main-one");
    expect(must(work, ["show", "HEAD~1:f1.txt"])).toBe("one");
    expect(must(work, ["show", "HEAD:f2.txt"])).toBe("two");
    expect(remoteTip(work, "feat")).toBe(must(work, ["rev-parse", "HEAD"]));
  });

  test("refuses to rewrite when the fetched remote tip is not integrated", () => {
    const root = scratch("rebase-main-remote-");
    const { remote, work: seed } = seedRemote(root);

    // feat exists on the remote so a coworker's push has somewhere to land.
    must(seed, ["checkout", "-b", "feat"]);
    put(seed, "feat.txt", "a1\n");
    must(seed, ["add", "-A"]);
    must(seed, ["commit", "-m", "feat base"]);
    must(seed, ["push", "-u", "origin", "feat"]);
    must(seed, ["checkout", "main"]);

    // The working clone is on feat with a local commit the remote lacks.
    const work = join(root, "clone");
    must(root, ["clone", remote, work]);
    must(work, ["checkout", "feat"]);
    put(work, "local.txt", "l\n");
    must(work, ["add", "-A"]);
    must(work, ["commit", "-m", "local work"]);
    const before = must(work, ["rev-parse", "HEAD"]);

    // A coworker pushes B on top of the same remote tip.
    const coworker = join(root, "coworker");
    must(root, ["clone", remote, coworker]);
    must(coworker, ["checkout", "feat"]);
    put(coworker, "cowork.txt", "b\n");
    must(coworker, ["add", "-A"]);
    must(coworker, ["commit", "-m", "coworker work"]);
    must(coworker, ["push", "origin", "feat"]);
    const coworkerTip = must(coworker, ["rev-parse", "HEAD"]);

    const r = run(work);
    expect(r.code).toBe(1);
    expect(r.err).toContain("has commits this branch does not");

    // Nothing was rewritten and nothing was pushed: HEAD is untouched and the
    // remote still points at the coworker's commit.
    expect(must(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(remoteTip(work, "feat")).toBe(coworkerTip);
  });
});
