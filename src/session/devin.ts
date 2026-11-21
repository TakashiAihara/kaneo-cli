import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The session id of the Devin CLI session this process runs under, or "".
//
// Devin CLI exports no session id variable, so the environment chain in
// currentId cannot see it. What it does leave is one flock'd file per live
// session under <data home>/devin/cli/session_locks/<slug>.lock, held by the
// session's agent process for as long as the session runs. A command the
// session spawns is that process's descendant, so the session it belongs to is
// the lock an ancestor holds — the same ancestor walk cc-sid's marker reader
// does, answered by the lock table instead of marker files.
//
// Linux only: both halves read /proc. Anywhere else this answers "", which is
// what an unresolvable session has always been.
export const devinSessionId = (env: (name: string) => string): string => {
  const files = lockFiles(locksDir(env));
  if (files.size === 0) return "";
  const ancestors = ancestorPids();
  if (ancestors.length === 0) return "";
  const held = heldInodes(new Set(ancestors));
  // Nearest ancestor first: a Devin session nested inside another resolves to
  // the inner one, which is the session the command actually runs in.
  for (const pid of ancestors) {
    for (const key of held.get(pid) ?? []) {
      const slug = files.get(key);
      if (slug !== undefined) return slug;
    }
  }
  return "";
};

// <XDG_DATA_HOME or ~/.local/share>/devin/cli/session_locks, the way the
// platform's data dir resolves. "" when there is no home to resolve against.
const locksDir = (env: (name: string) => string): string => {
  const dataHome = env("XDG_DATA_HOME").trim();
  if (dataHome !== "") return join(dataHome, "devin", "cli", "session_locks");
  const home = env("HOME").trim();
  return join(home === "" ? homedir() : home, ".local", "share", "devin", "cli", "session_locks");
};

// inode → session slug for every lock file present. A file whose process is
// gone stays on disk, so presence alone says nothing; /proc/locks says who
// holds it now. statSync per file is the price of binding a held inode back to
// its name — a few hundred small stats, only on the path where no session id
// variable was set.
const lockFiles = (dir: string): Map<string, string> => {
  const files = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    const slug = name.slice(0, -".lock".length);
    if (slug === "") continue;
    try {
      files.set(inoKey(statSync(join(dir, name))), slug);
    } catch {
      // Vanished between the listing and the stat.
    }
  }
  return files;
};

// The "major:minor:inode" triple /proc/locks prints for a file, in the kernel's
// own encoding: dev_t splits into a 12-bit major and a 20-bit minor, printed
// %02x each, and the inode decimal. BigInt because dev_t is 64 bits and the
// high word carries major bits a 32-bit shift would lose.
const inoKey = (st: { dev: number; ino: number }): string => {
  const dev = BigInt(st.dev);
  const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn));
  const minor = Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn));
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  return `${hex(major)}:${hex(minor)}:${st.ino}`;
};

// pids of this process's ancestors, nearest first. /proc/<pid>/stat's comm
// field can hold spaces and parentheses, so the fields after the last ")" are
// the ones read: state, then ppid.
const ancestorPids = (): number[] => {
  const pids: number[] = [];
  let pid = process.ppid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    const ppid = procPpid(pid);
    if (ppid === undefined) break;
    pids.push(pid);
    pid = ppid;
  }
  return pids;
};

const procPpid = (pid: number): number | undefined => {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return undefined;
    const ppid = Number(text.slice(close + 2).split(" ")[1]);
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
};

// The "major:minor:inode" keys each wanted pid holds an FLOCK on, from
// /proc/locks. Only FLOCK counts: that is the lock Devin's session files are
// taken with, and a POSIX or OFD lock on the same file is a different claim.
const heldInodes = (pids: ReadonlySet<number>): Map<number, Set<string>> => {
  const held = new Map<number, Set<string>>();
  let text: string;
  try {
    text = readFileSync("/proc/locks", "utf8");
  } catch {
    return held;
  }
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // "<n>: FLOCK ADVISORY WRITE <pid> <maj>:<min>:<ino> <start> <end>"
    if (fields.length < 6 || fields[1] !== "FLOCK") continue;
    const pid = Number(fields[4]);
    const key = fields[5] ?? "";
    if (!pids.has(pid) || !/^[0-9a-f]+:[0-9a-f]+:\d+$/.test(key)) continue;
    let set = held.get(pid);
    if (set === undefined) held.set(pid, (set = new Set()));
    set.add(key);
  }
  return held;
};
