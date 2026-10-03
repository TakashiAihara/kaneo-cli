import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clear, load, save, type Attachment, type Store } from "../../src/session/store";

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
      workspaceId: "w",
      workspaceName: "W",
    };
    save(store, "new", full);
    expect(readFileSync(join(dir, "new.json"), "utf8").startsWith('{"taskId":"t","number":1,"title":"x",')).toBe(true);
    expect(load(store, "new")).toEqual(full);
  });
});
