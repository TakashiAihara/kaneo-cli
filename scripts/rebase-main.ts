import { existsSync } from "node:fs";
import { join } from "node:path";

// Rebases the current branch onto origin/main and rebuilds what a merge
// cannot: the generated client under src/api/gen and the parity goldens under
// tests/parity/golden. Parallel sessions add API operations at the same time,
// and every main merge moves both, so each rebase used to be a hand-run
// sequence: squash, rebase, take main's side of the generated paths, install,
// generate, record, test, push.
//
//   bun run rebase:main
//
// The branch's commits are first squashed into one, the way the PRs here are
// merged anyway. A branch that already merged main before keeps its merges
// and is merged forward instead, so it does not need a force push it was
// avoiding. Conflicts in the generated paths are taken from main's side and
// rebuilt; any other conflict stops the run with the list, and re-running the
// command resumes wherever it stopped. Before rewriting, the remote tip the
// fetch saw must already be in local history, and the push leases on that
// exact tip with --force-if-includes, so a coworker's push to the same branch
// is refused rather than overwritten.
//
// Exit codes: 0 done, 1 error, 3 conflicts left for a human.

const ROOT = join(import.meta.dir, "..");

// GIT_EDITOR=true keeps `rebase --continue` and `merge --continue` from
// opening an editor on the message they reuse anyway; the environment's
// editor is a TUI that would hang a non-interactive run.
const GIT_ENV = { ...process.env, GIT_EDITOR: "true", EDITOR: "true", VISUAL: "true" };

// Piped output for the caller to read.
const capture = (args: string[]): { code: number; stdout: string; stderr: string } => {
  const r = Bun.spawnSync(args, { cwd: ROOT, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

// Inherited output for the steps whose progress the user should watch; only
// the exit code comes back.
const stream = (args: string[]): number =>
  Bun.spawnSync(args, { cwd: ROOT, env: GIT_ENV, stdout: "inherit", stderr: "inherit" }).exitCode;

const gitOut = (args: string[]): string => {
  const r = capture(["git", ...args]);
  if (r.code !== 0) fail(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

const must = (args: string[], what: string) => {
  if (stream(["git", ...args]) !== 0) fail(`${what} failed (git ${args.join(" ")})`);
};

const bun = (args: string[], what: string) => {
  if (stream(["bun", ...args]) !== 0) fail(`${what} failed (bun ${args.join(" ")})`);
};

function fail(message: string): never {
  console.error(`rebase-main: ${message}`);
  process.exit(1);
}

const gitDir = () => gitOut(["rev-parse", "--absolute-git-dir"]);

const inProgress = (): boolean => {
  const dir = gitDir();
  return (
    existsSync(join(dir, "rebase-merge")) ||
    existsSync(join(dir, "rebase-apply")) ||
    existsSync(join(dir, "MERGE_HEAD"))
  );
};

// Paths whose content is generated rather than written: a conflict there is
// resolved by taking main's side and rebuilding, never by hand.
const GENERATED = ["src/api/gen/", "tests/parity/golden/"];

const isGenerated = (path: string): boolean => GENERATED.some((dir) => path.startsWith(dir));

// Takes main's side of one conflicted path: its blob when main has one, its
// absence when main deleted it. During a rebase "ours" is the replayed branch
// and "theirs" is main, and during a merge it is the other way round, so the
// resolution reads origin/main directly rather than a stage number.
const takeMainSide = (path: string) => {
  const has = stream(["git", "cat-file", "-e", `origin/main:${path}`]) === 0;
  if (has) {
    must(["checkout", "origin/main", "--", path], `checkout ${path}`);
    must(["add", "--", path], `add ${path}`);
  } else {
    // Absent on main means the resolution is a deletion; git rm clears the
    // unmerged entries itself.
    must(["rm", "-f", "--", path], `rm ${path}`);
  }
};

// True while the operation is still running and left conflicts behind: the
// only non-zero stop that is not an error, because the loop resolves what is
// left and calls continue again.
const stoppedOnConflicts = (): boolean => inProgress() && unmerged().length > 0;

// Runs `continue` for the operation in progress. A commit the rebase emptied
// stops the same way a conflict does, and --continue refuses it; --skip drops
// it, which is right when every change is already on main.
const continueOperation = (mode: "rebase" | "merge") => {
  const args = mode === "rebase" ? ["-c", "core.editor=true", "rebase", "--continue"] : ["merge", "--continue"];
  // --continue exits non-zero when it stops on the NEXT commit's conflicts,
  // not only on errors; the unmerged paths it leaves are the loop's work.
  if (stream(["git", ...args]) === 0 || stoppedOnConflicts()) return;
  if (mode === "rebase" && gitOut(["status", "--porcelain"]) === "" && inProgress()) {
    // --skip can itself stop on the next commit's conflicts the same way.
    if (stream(["git", "rebase", "--skip"]) === 0 || stoppedOnConflicts()) return;
    fail("rebase --skip failed (git rebase --skip)");
  }
  fail(`could not continue the ${mode} (see output above)`);
};

const unmerged = (): string[] => {
  const listed = gitOut(["diff", "--name-only", "--diff-filter=U"]);
  return listed === "" ? [] : listed.split("\n");
};

// Resolves generated-path conflicts from main's side and continues until the
// operation finishes. Returns the mode it ran, for the push decision.
const resolveAndContinue = (mode: "rebase" | "merge"): void => {
  for (;;) {
    if (!inProgress()) return;
    const conflicts = unmerged();
    const manual = conflicts.filter((path) => !isGenerated(path));
    for (const path of conflicts.filter(isGenerated)) takeMainSide(path);
    if (manual.length > 0) {
      console.error("rebase-main: conflicts remain that are not generated paths:");
      for (const path of manual) console.error(`  ${path}`);
      console.error("resolve them and re-run `bun run rebase:main` to continue");
      process.exit(3);
    }
    continueOperation(mode);
  }
};

const main = () => {
  if (stream(["git", "rev-parse", "--is-inside-work-tree"]) !== 0) {
    fail("not inside a git repository");
  }
  gitOut(["remote", "get-url", "origin"]);

  let mode: "rebase" | "merge";
  // The remote tip the push is allowed to replace, fixed at fetch time; null
  // on a resumed run, where there is no fresh fetch to take it from.
  let remoteTip: string | null = null;
  if (inProgress()) {
    // Resuming: the mode is whichever operation left its state behind.
    const dir = gitDir();
    mode = existsSync(join(dir, "MERGE_HEAD")) ? "merge" : "rebase";
    console.log(`resuming the ${mode} in progress`);
  } else {
    if (gitOut(["status", "--porcelain"]) !== "") {
      fail("the working tree is not clean; commit or stash first");
    }
    gitOut(["fetch", "origin"]);
    gitOut(["rev-parse", "--verify", "origin/main"]);

    const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD" || branch === "main" || branch === "master") {
      fail(`refusing to rebase ${branch}; check out the branch to update`);
    }

    // fetch just moved origin/<branch> to the remote's tip. If that tip has
    // commits this branch does not, the rewrite below would drop them: the
    // push's lease compares the remote against the same tracking ref, so it
    // would pass. Refuse before rewriting; --force-if-includes repeats the
    // check at push time.
    remoteTip = "";
    const tracking = capture(["git", "rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
    if (tracking.code === 0) {
      remoteTip = tracking.stdout.trim();
      if (capture(["git", "merge-base", "--is-ancestor", remoteTip, "HEAD"]).code !== 0) {
        fail(`origin/${branch} has commits this branch does not (${remoteTip}); merge or rebase them in first`);
      }
    }

    const merges = Number(gitOut(["rev-list", "--merges", "--count", "origin/main..HEAD"]));
    if (merges > 0) {
      // A branch that merged main before keeps merging: squashing would
      // flatten the merges it was built to keep, and force-pushing would
      // undo the reason it merged.
      mode = "merge";
      if (stream(["git", "merge", "origin/main", "--no-edit"]) !== 0 && !inProgress()) {
        fail("merge origin/main failed");
      }
    } else {
      mode = "rebase";
      const ahead = Number(gitOut(["rev-list", "--count", "origin/main..HEAD"]));
      if (ahead > 1) {
        const tip = gitOut(["rev-parse", "HEAD"]);
        const base = gitOut(["merge-base", "HEAD", "origin/main"]);
        must(["reset", "--soft", base], "reset --soft");
        must(["commit", "-C", tip], "squash commit");
        console.log(`squashed ${ahead} commits into one`);
      }
      if (stream(["git", "rebase", "origin/main"]) !== 0 && !inProgress()) {
        fail("rebase origin/main failed");
      }
    }
  }

  resolveAndContinue(mode);

  if (gitOut(["rev-list", "--count", "origin/main..HEAD"]) === "0") {
    console.log("rebase-main: the branch has no commits beyond origin/main; nothing to rebuild");
    return;
  }
  if (gitOut(["status", "--porcelain"]) !== "") {
    fail("the tree is not clean after the history operation; inspect it before re-running");
  }

  bun(["install", "--frozen-lockfile"], "bun install");
  bun(["run", "generate"], "bun run generate");
  bun(["scripts/record-golden.ts"], "record golden");

  // What the rebuild actually changed, before it is amended in: a rebase that
  // moved the generated paths always rewrites some, and the list is how a
  // human sees whether the writes are the branch's own updates or drift.
  const changed = gitOut(["status", "--porcelain", "--", "src/api/gen", "tests/parity/golden"]);
  if (changed !== "") {
    console.log("regenerated paths changed:");
    for (const line of changed.split("\n")) console.log(`  ${line}`);
  }
  must(["add", "src/api/gen", "tests/parity/golden"], "stage generated paths");
  if (stream(["git", "diff", "--cached", "--quiet"]) !== 0) {
    must(["commit", "--amend", "--no-edit"], "amend regenerated output");
  }
  bun(["test"], "bun test");
  // bun test transpiles without checking types, and a hand-resolved conflict
  // can leave declarations that only tsc refuses (the issue's union-merge
  // note), so the type check runs here too.
  bun(["run", "typecheck"], "typecheck");

  const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
  // remoteTip is the remote tip verified against local history right after
  // the fetch; on a resumed run there was no fetch, so the tracking ref is
  // the same value a bare lease would compare. "" expects the remote to have
  // no such branch. --force-if-includes additionally refuses a tracking tip
  // that was never integrated locally — a coworker's push fetch moved
  // origin/<branch> to without this branch containing it.
  const tracked = capture(["git", "rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
  const expected = remoteTip ?? (tracked.code === 0 ? tracked.stdout.trim() : "");
  must(
    [
      "push",
      `--force-with-lease=refs/heads/${branch}:${expected}`,
      "--force-if-includes",
      "-u",
      "origin",
      `HEAD:refs/heads/${branch}`,
    ],
    "push",
  );

  // DIRTY means GitHub never starts CI on the pushed head, so it is worth one
  // look right after the push rather than a confused wait later.
  let pr: { code: number; stdout: string } | null = null;
  try {
    pr = capture(["gh", "pr", "view", "--json", "mergeStateStatus", "--jq", ".mergeStateStatus"]);
  } catch {
    // gh missing or not logged in: the check is a courtesy, not a gate.
  }
  if (pr !== null && pr.code === 0) {
    const state = pr.stdout.trim();
    console.log(`mergeStateStatus: ${state}`);
    if (state === "DIRTY") {
      console.error("rebase-main: mergeStateStatus is DIRTY; CI may not start — check the PR before waiting on it");
    }
  } else {
    console.log("rebase-main: skipped the mergeStateStatus check (no pull request or gh unavailable)");
  }
  console.log("rebase-main: done");
};

main();
