import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeSync } from "node:fs";
import { z } from "zod";
import type { App } from "./app";
import { noArgs } from "./args";
import type { Json } from "../output/json";

// `kaneo upgrade` is install.sh run from inside the binary: the same release
// endpoints, the same checksum verification, the same stage-then-verify-then-
// move sequence, so a stale install is fixed by the tool itself rather than by
// finding the install script again. Installs that predate this command are
// updated the old way once, and every release after that can update itself.
//
// The unit tests drive upgrade() against a local server; the command only adds
// the environment variables install.sh already honours and the path of the
// running binary.

const REPO = "TakashiAihara/kaneo-cli";
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_BASE = `https://github.com/${REPO}/releases/download`;

const LatestRelease = z.object({ tag_name: z.string().min(1) });

export type UpgradeResult =
  | { upgraded: false; version: string }
  | { upgraded: true; from: string; to: string; path: string };

export type UpgradeOptions = {
  // The file the new binary replaces. It must be a runnable kaneo binary:
  // anything else — the Bun runtime under `bun run`, a shell wrapper — is
  // refused before a byte is downloaded, because replacing it would destroy
  // the thing running this command.
  target: string;
  // The release tag to install; "" means the latest release.
  version?: string;
  // Where the archives and checksums.txt live; mirrors install.sh's
  // KANEO_RELEASE_BASE.
  releaseBase?: string;
  // The latest-release endpoint; injectable so tests never reach GitHub.
  latestUrl?: string;
  fetchFn?: typeof fetch;
  // The platform the archive is chosen for; injectable for the same reason.
  os?: string;
  arch?: string;
  // Progress lines; stderr by default, matching install.sh.
  log?: (line: string) => void;
};

const archiveName = (os: string, arch: string): string => {
  const osName = os === "linux" ? "linux" : os === "darwin" ? "darwin" : "";
  if (osName === "") throw new Error(`unsupported OS: ${os}`);
  const archName = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : "";
  if (archName === "") throw new Error(`unsupported architecture: ${arch}`);
  return `kaneo_${osName}_${archName}.tar.gz`;
};

// What `[path, --version]` reports, or a refusal. The staged binary gets the
// same check before it replaces anything: a download that extracts but does
// not run must not take the working install down with it.
const reportedVersion = (path: string): string => {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const refuse = `${path} is not a runnable kaneo binary; kaneo upgrade replaces an installed release, so run it from the binary install.sh placed`;
  let out = "";
  let code = 1;
  try {
    const probe = Bun.spawnSync([path, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    out = probe.stdout.toString().trim();
    code = probe.exitCode;
  } catch {
    // A file that cannot be executed at all is as un-runnable as one whose
    // --version exits wrong; both are refused below.
  }
  const match = /^kaneo version (\S+)$/.exec(out);
  if (code !== 0 || match === null) throw new Error(refuse);
  return match[1]!;
};

const get = async (url: string, fetchFn: typeof fetch): Promise<Response> => {
  // GitHub's API refuses requests without a User-Agent; Bun's default one is
  // not guaranteed to be sent, so name the client the way curl does.
  const res = await fetchFn(url, { headers: { "user-agent": "kaneo-cli" } });
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  return res;
};

const latestTag = async (latestUrl: string, fetchFn: typeof fetch): Promise<string> => {
  const res = await get(latestUrl, fetchFn);
  const parsed = LatestRelease.safeParse(await res.json());
  if (!parsed.success) throw new Error(`${latestUrl} did not return a release with a tag_name`);
  return parsed.data.tag_name;
};

// sha256sum format: "<hash>  <name>". A name the file does not list is a hard
// failure, the way install.sh treats it: installing unverified is worse than
// not installing.
const verifyChecksum = (archive: Uint8Array, sums: string, name: string): void => {
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((fields) => fields[1] === name)?.[0];
  if (expected === undefined) throw new Error(`${name} is not listed in checksums.txt`);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (expected !== actual) {
    throw new Error(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
};

const untar = (archive: string, dir: string, name: string): void => {
  const r = Bun.spawnSync(["tar", "-xzf", archive, "-C", dir], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`could not unpack ${name}: ${r.stderr.toString().trim()}`);
};

export const upgrade = async (opts: UpgradeOptions): Promise<UpgradeResult> => {
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? ((line: string) => writeSync(2, `${line}\n`));

  const from = reportedVersion(opts.target);
  const name = archiveName(opts.os ?? process.platform, opts.arch ?? process.arch);
  const pin = (opts.version ?? "").trim();
  const tag = pin === "" ? await latestTag(opts.latestUrl ?? LATEST_URL, fetchFn) : pin;
  // "" means unset the way install.sh's ${KANEO_RELEASE_BASE:-...} does; ??
  // alone would keep it and fetch a relative URL.
  const base = (opts.releaseBase || RELEASE_BASE).replace(/\/+$/, "");

  // The tag carries the release's v prefix and the binary does not, so the
  // comparison strips it rather than comparing the two spellings.
  if (tag.replace(/^v/, "") === from) return { upgraded: false, version: tag };

  log(`downloading ${name} ${tag}`);
  const archiveRes = await get(`${base}/${tag}/${name}`, fetchFn);
  const archive = new Uint8Array(await archiveRes.arrayBuffer());
  const sumsRes = await get(`${base}/${tag}/checksums.txt`, fetchFn);
  verifyChecksum(archive, await sumsRes.text(), name);

  const tmp = mkdtempSync(join(tmpdir(), "kaneo-upgrade-"));
  // Staged beside the destination so the final rename is atomic and on the
  // same filesystem; a failed download or probe leaves the old binary alone.
  const staged = join(dirname(opts.target), `.kaneo.incoming.${process.pid}`);

  // A signal mid-upgrade would strand the temp dir and the staged binary, the
  // same litter install.sh's traps exist to prevent. exit() runs the EXIT
  // cleanup below through the finally.
  const cleanup = (): void => {
    try {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(staged, { force: true });
    } catch {
      // A cleanup that fails must not replace the exit status the run is
      // leaving with, the way install.sh's `|| :` keeps it.
    }
  };
  const onSigint = (): void => {
    cleanup();
    process.exit(130);
  };
  const onSigterm = (): void => {
    cleanup();
    process.exit(143);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    writeFileSync(join(tmp, name), archive);
    untar(join(tmp, name), tmp, name);
    const binary = join(tmp, "kaneo");
    if (!existsSync(binary)) throw new Error("the archive did not contain a kaneo binary");

    copyFileSync(binary, staged);
    chmodSync(staged, 0o755);

    const to = reportedVersion(staged);
    renameSync(staged, opts.target);
    log(`installed kaneo version ${to} to ${opts.target}`);
    return { upgraded: true, from, to, path: opts.target };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    cleanup();
  }
};

export const upgradeCommand = {
  name: "upgrade",
  short: "Replace this binary with the latest release",
  long:
    "Download the release install.sh would fetch — the latest, or the tag\n" +
    "KANEO_VERSION names — verify its checksum, and replace the binary this\n" +
    "command runs from. The new binary is staged, run once, and moved into\n" +
    "place only if it answers --version, so a bad download cannot take the\n" +
    "working install down.\n\n" +
    "Environment:\n" +
    "  KANEO_VERSION       tag to install (default: the latest release)\n" +
    "  KANEO_RELEASE_BASE  where to fetch archives from, for a mirror",
  args: noArgs("kaneo upgrade"),
  run: async ({ app }: { app: App }) => {
    const result = await upgrade({
      // realpath so a symlinked install (a version manager, ~/bin/kaneo ->
      // elsewhere) updates the file every link points at, not the link.
      target: realpathSync(process.execPath),
      version: process.env.KANEO_VERSION ?? "",
      releaseBase: process.env.KANEO_RELEASE_BASE || undefined,
      log: (line) => app.out.status(line),
    });
    const data: Json = result.upgraded
      ? { upgraded: true, from: result.from, to: result.to, path: result.path }
      : { upgraded: false, version: result.version };
    app.out.data(data);
  },
};
