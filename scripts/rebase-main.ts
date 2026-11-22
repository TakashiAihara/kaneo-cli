import { existsSync, readFileSync } from "node:fs";
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
// command resumes wherever it stopped. Before rewriting — on a fresh run and
// again when one resumes — the remote tip the fetch saw must already be in
// the branch's local history, and the push leases on that exact tip, so a
// coworker's push to the same branch is refused rather than overwritten.
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

// True when the remote tip's commits are part of this branch's local story:
// reachable from HEAD, or from any tip the branch's reflog still remembers.
// The reflog arm is what a retry after this script's own rewrite needs — the
// verified tip stopped being an ancestor of HEAD when history was rewritten,
// but it was an ancestor of the pre-rewrite tip the reflog records. A
// coworker's push is never in the reflog, so it still fails both arms. This
// is the same reachability --force-if-includes checks at push time.
const tipIntegrated = (tip: string, branch: string): boolean => {
  const isAncestor = (rev: string) => capture(["git", "merge-base", "--is-ancestor", tip, rev]).code === 0;
  if (isAncestor("HEAD")) return true;
  const reflog = capture(["git", "reflog", "show", `refs/heads/${branch}`, "--format=%H"]);
  return reflog.code === 0 && reflog.stdout.split("\n").some((rev) => rev !== "" && isAncestor(rev));
};

// The tip origin/<branch> had at the last fetch, once verified integrated;
// "" when the remote has no such branch. Refuses before rewriting when the
// tip has commits this branch's history never held — the push leases on this
// same value, so proceeding would drop them.
const verifiedRemoteTip = (branch: string): string => {
  const tracking = capture(["git", "rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
  if (tracking.code !== 0) return "";
  const tip = tracking.stdout.trim();
  if (!tipIntegrated(tip, branch)) {
    fail(`origin/${branch} has commits this branch does not (${tip}); merge or rebase them in first`);
  }
  return tip;
};

// The branch a stopped operation was rewriting, for the resume-time remote
// check. A merge in progress keeps HEAD on the branch; a rebase records it in
// its state dir because HEAD is detached mid-replay. null when neither names
// one (a detached rebase run by hand), where there is no branch to lease.
const resumedBranch = (): string | null => {
  const dir = gitDir();
  if (existsSync(join(dir, "MERGE_HEAD"))) {
    const name = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
    return name === "HEAD" ? null : name;
  }
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const headName = join(dir, state, "head-name");
    if (existsSync(headName)) {
      const ref = readFileSync(headName, "utf8").trim();
      return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    }
  }
  return null;
};

const main = () => {
  if (stream(["git", "rev-parse", "--is-inside-work-tree"]) !== 0) {
    fail("not inside a git repository");
  }
  gitOut(["remote", "get-url", "origin"]);

  let mode: "rebase" | "merge";
  // The remote tip the push is allowed to replace, fixed at fetch time; ""
  // when the remote has no such branch.
  let remoteTip = "";
  if (inProgress()) {
    // Resuming: the mode is whichever operation left its state behind.
    const dir = gitDir();
    mode = existsSync(join(dir, "MERGE_HEAD")) ? "merge" : "rebase";
    console.log(`resuming the ${mode} in progress`);
    // The resume still force-pushes, so it owes the same fetch and remote-tip
    // check a fresh run does: a coworker push that landed while the operation
    // sat stopped must not be leased over. A rebase's HEAD is detached
    // mid-replay, so its state dir names the branch.
    gitOut(["fetch", "origin"]);
    const branch = resumedBranch();
    if (branch !== null) remoteTip = verifiedRemoteTip(branch);
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
    // commits this branch's history never held, the rewrite below would drop
    // them: the push's lease compares the remote against this same verified
    // value. Refuse before rewriting.
    remoteTip = verifiedRemoteTip(branch);

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
  // remoteTip is the remote tip verified against this branch's history right
  // after the fetch — a resumed run fetches too, so both paths pin the same
  // kind of value. "" expects the remote to have no such branch. The lease's
  // explicit expect makes --force-if-includes a no-op (git-push(1)), and the
  // integration check it would repeat already ran against this tip.
  must(
    ["push", `--force-with-lease=refs/heads/${branch}:${remoteTip}`, "-u", "origin", `HEAD:refs/heads/${branch}`],
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
