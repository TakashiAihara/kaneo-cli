import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, clear, load, readHistory, save, type Attachment, type Store } from "../../src/session/store";

// Ported from the Go build's internal/session/store_test.go.

const scratch: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "kaneo-store-"));
  scratch.push(d);
  return d;
};
const sleepers: string[] = [];
const killRecorded = (pidFile: string) => {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch {
    // never started, or already gone
  }
};
const savedPath = process.env.PATH;
afterEach(() => {
  for (const f of sleepers.splice(0)) killRecorded(f);
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("store", () => {
  // The session id comes from the environment, so it is not this program's to
  // trust.
  test("TestStoreRejectsSessionIDsThatEscape", () => {
    const root = tmp();
    const store: Store = { dir: join(root, "store"), legacyDirs: [] };
    const victim = join(root, "victim.json");
    const original = '{"taskId":"do-not-touch"}';
    writeFileSync(victim, original, { mode: 0o600 });

    for (const id of ["../victim", "../../victim", "a/../../victim", "sub/victim", "sub\\victim", "..", ".", ""]) {
      expect(() => save(store, id, { taskId: "OVERWRITTEN", number: 0, title: "" }), `save(${id}) was accepted`).toThrow();
      expect(load(store, id), `load(${id}) was accepted`).toBeUndefined();
      clear(store, id);
    }
    expect(existsSync(victim), "the file outside the store was removed").toBe(true);
    expect(readFileSync(victim, "utf8")).toBe(original);
  });

  test("TestStoreAcceptsOrdinarySessionIDs", () => {
    const store: Store = { dir: tmp(), legacyDirs: [] };
    for (const id of ["54c76464-299c-460e-9e3f-77556f55a02b", "01M0Y1VTEME00B", "plain"]) {
      save(store, id, { taskId: "t", number: 1, title: "x" });
      expect(load(store, id)?.taskId, id).toBe("t");
      clear(store, id);
      expect(load(store, id), `clear(${id}) did not remove the record`).toBeUndefined();
    }
  });

  test("TestStoreFilePermissions", () => {
    const dir = join(tmp(), "store");
    save({ dir, legacyDirs: [] }, "s1", { taskId: "t", number: 0, title: "" });
    expect(statSync(join(dir, "s1.json")).mode & 0o777).toBe(0o600);
  });

  // currentBranch is not exported, so it is reached through describe. Bun
  // resolves `git` against the PATH the process started with, so the stub is
  // put on the PATH of a child process; setting it on this one is ignored.
  const branchVia = (stub: string, dir: string) => {
    const start = Date.now();
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { describe } from ${JSON.stringify(join(import.meta.dir, "../../src/session/store"))};` +
          `process.stdout.write(JSON.stringify(describe(() => "", ${JSON.stringify(dir)}, "running").branch));`,
      ],
      { env: { PATH: `${stub}:${savedPath}`, HOME: dir }, stdin: "ignore", stderr: "pipe", timeout: 45_000 },
    );
    expect(child.stderr.toString()).toBe("");
    return { branch: JSON.parse(child.stdout.toString()) as string, elapsed: Date.now() - start };
  };

  // git can block indefinitely, and this runs from a session-start hook. The
  // sleep is a grandchild on purpose: killing the shell does not close the
  // stdout pipe it inherited.
  test(
    "TestCurrentBranchGivesUpOnAHangingGit",
    () => {
      const stub = tmp();
      const pidFile = join(stub, "sleeper.pid");
      writeFileSync(join(stub, "git"), `#!/bin/sh\nsleep 29.2 &\necho $! > "${pidFile}"\nwait\n`, { mode: 0o755 });
      sleepers.push(pidFile);

      const { branch, elapsed } = branchVia(stub, tmp());

      expect(existsSync(pidFile), "the stub git never ran").toBe(true);
      expect(elapsed, `took ${elapsed}ms, want about 2000`).toBeLessThan(6000);
      expect(branch).toBe("");
    },
    60_000,
  );

  // The stub must not make the test pass for the wrong reason.
  test("TestCurrentBranchReadsAResponsiveGit", () => {
    const stub = tmp();
    writeFileSync(join(stub, "git"), "#!/bin/sh\necho feature/x\n", { mode: 0o755 });
    expect(branchVia(stub, tmp()).branch).toBe("feature/x");
  });

  // A legacy directory is a migration aid, not a fallback for a damaged current
  // record.
  test("TestLoadDoesNotFallBackToLegacyOnACorruptCurrentRecord", () => {
    const root = tmp();
    const store: Store = { dir: join(root, "current"), legacyDirs: [join(root, "legacy")] };
    mkdirSync(store.dir, { recursive: true });
    mkdirSync(store.legacyDirs[0]!, { recursive: true });
    writeFileSync(join(store.dir, "s1.json"), "{not json");
    writeFileSync(join(store.legacyDirs[0]!, "s1.json"), '{"taskId":"stale","number":99}');
    expect(load(store, "s1")).toBeUndefined();
  });

  test("TestLoadFallsBackToLegacyWhenNothingIsRecorded", () => {
    const root = tmp();
    const store: Store = { dir: join(root, "current"), legacyDirs: [join(root, "legacy")] };
    mkdirSync(store.legacyDirs[0]!, { recursive: true });
    writeFileSync(join(store.legacyDirs[0]!, "s1.json"), '{"taskId":"from-legacy","number":7}');
    expect(load(store, "s1")?.taskId).toBe("from-legacy");
  });

  // Files written before the project fields existed must still load, and a
  // record without a project must serialise exactly as it did before.
  test("TestStoreProjectFieldsAreAdditive", () => {
    const dir = tmp();
    const store: Store = { dir, legacyDirs: [] };
    const old = '{"taskId":"t","number":1,"title":"x"}';

    writeFileSync(join(dir, "old.json"), old);
    expect(load(store, "old")).toEqual({ taskId: "t", number: 1, title: "x" });

    save(store, "bare", { taskId: "t", number: 1, title: "x" });
    expect(readFileSync(join(dir, "bare.json"), "utf8")).toBe(old);

    const full: Attachment = {
      taskId: "t",
      number: 1,
      title: "x",
      projectId: "p",
      projectName: "P",
      projectSlug: "P",
      workspaceId: "w",
      workspaceName: "W",
    };
    save(store, "new", full);
    expect(readFileSync(join(dir, "new.json"), "utf8").startsWith('{"taskId":"t","number":1,"title":"x",')).toBe(true);
    expect(load(store, "new")).toEqual(full);
  });

  // The slug is what a task reference is written as, so an attachment has to
  // carry it as one of the names rather than as a lookup the reader repeats.
  test("TestStoreKeepsTheProjectSlug", () => {
    const dir = tmp();
    const store: Store = { dir, legacyDirs: [] };
    save(store, "s1", { taskId: "t", number: 3, title: "x", projectId: "p", projectName: "P", projectSlug: "PL" });
    expect(readFileSync(join(dir, "s1.json"), "utf8")).toBe(
      '{"taskId":"t","number":3,"title":"x","projectId":"p","projectName":"P","projectSlug":"PL"}',
    );
    expect(load(store, "s1")?.projectSlug).toBe("PL");
  });

  test("TestHistoryFilePermissions", () => {
    const dir = join(tmp(), "store");
    appendHistory({ dir, legacyDirs: [] }, "s1", "attach", { taskId: "t", number: 1, title: "x" }, new Date());
    expect(statSync(join(dir, "s1.history.jsonl")).mode & 0o777).toBe(0o600);
  });

  // A session is attached and closed more than once, so the history is only ever
  // added to: rewriting it would lose the trail #19 is the record of.
  test("TestHistoryIsAppended", () => {
    const dir = tmp();
    const store: Store = { dir, legacyDirs: [] };
    const attachment: Attachment = { taskId: "t", number: 1, title: "x", projectId: "p", projectSlug: "PL" };

    appendHistory(store, "s1", "attach", attachment, new Date("2026-01-01T00:00:00.000Z"));
    appendHistory(store, "s1", "close", attachment, new Date("2026-01-01T00:00:01.000Z"));

    const lines = readFileSync(join(dir, "s1.history.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(
      '{"event":"attach","at":"2026-01-01T00:00:00.000Z","taskId":"t","number":1,"title":"x","projectId":"p","projectSlug":"PL"}',
    );
    expect(lines[1]).toBe(
      '{"event":"close","at":"2026-01-01T00:00:01.000Z","taskId":"t","number":1,"title":"x","projectId":"p","projectSlug":"PL"}',
    );

    // A close leaves the history behind, since it is all that is left of the
    // attachment once the session has let the task go.
    clear(store, "s1");
    expect(existsSync(join(dir, "s1.json"))).toBe(false);
    expect(existsSync(join(dir, "s1.history.jsonl"))).toBe(true);
    expect(readHistory(store, "s1").entries.length).toBe(2);
  });

  // A crash mid-write leaves a last line with no newline; the next event must
  // start its own line, or the close a retro looks for is lost with it.
  test("TestHistoryAppendStartsAfterACutLine", () => {
    const dir = tmp();
    const store: Store = { dir, legacyDirs: [] };
    writeFileSync(join(dir, "s1.history.jsonl"), '{"event":"att');

    appendHistory(store, "s1", "close", { taskId: "t", number: 1, title: "x" }, new Date("2026-01-01T00:00:00.000Z"));

    const { entries, skipped } = readHistory(store, "s1");
    expect(skipped).toBe(1);
    expect(entries).toEqual([
      { event: "close", at: "2026-01-01T00:00:00.000Z", taskId: "t", number: 1, title: "x" },
    ]);
  });

  test("TestHistoryRejectsSessionIDsThatEscape", () => {
    const root = tmp();
    const store: Store = { dir: join(root, "store"), legacyDirs: [] };
    const attachment: Attachment = { taskId: "t", number: 1, title: "x" };

    for (const id of ["../victim", "../../victim", "sub/victim", "sub\\victim", "..", "."]) {
      expect(() => appendHistory(store, id, "attach", attachment, new Date()), `appendHistory(${id})`).toThrow(
        "may not contain a path separator",
      );
    }
    expect(() => appendHistory(store, "", "attach", attachment, new Date())).toThrow("no session id");
    expect(existsSync(join(root, "victim.history.jsonl"))).toBe(false);

    // Reading is held to the same ids: a history placed where an escaping id
    // points must not be read back as this session's.
    writeFileSync(join(root, "victim.history.jsonl"), '{"event":"attach","number":1}\n');
    expect(readHistory(store, "../victim")).toEqual({ entries: [], skipped: 0 });
  });

  // One damaged line is not a reason to hide the rest: the history is the only
  // record of what a closed session did, and the count says what is missing.
  test("TestHistorySkipsLinesItCannotRead", () => {
    const dir = tmp();
    const store: Store = { dir, legacyDirs: [] };
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(
      join(dir, "s1.history.jsonl"),
      '{"event":"attach","at":"2026-01-01T00:00:00.000Z","taskId":"t","number":1,"title":"x"}\n{not json\nnull\n3\n[]\n\n',
    );

    const { entries, skipped } = readHistory(store, "s1");
    expect(skipped).toBe(4);
    expect(entries.length).toBe(1);
    expect(readHistory(store, "never-attached")).toEqual({ entries: [], skipped: 0 });
  });
});
