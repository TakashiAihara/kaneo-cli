import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgrade } from "../../src/cli/upgrade";

// `kaneo upgrade` replaces the running binary with a release archive, so what
// is pinned here is the whole contract install.sh keeps: the archive is found
// by tag, its sha256 must match checksums.txt, the unpacked binary must answer
// --version as kaneo before it may replace anything, and a failure at any step
// leaves the installed binary and the target directory untouched. The server
// is a Bun.serve fixture on loopback; nothing reaches GitHub.

const roots: string[] = [];
const servers: { stop: (closeActiveConnections?: boolean) => void }[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "upgrade-test-"));
  roots.push(dir);
  return dir;
};

// A file that answers --version the way an installed release does.
const fakeBinary = (dir: string, version: string): string => {
  const path = join(dir, "kaneo");
  writeFileSync(path, `#!/bin/sh\necho "kaneo version ${version}"\n`);
  chmodSync(path, 0o755);
  return path;
};

const versionOf = (path: string): string =>
  Bun.spawnSync([path, "--version"], { stdout: "pipe" }).stdout.toString().trim();

// Packs files into the archive shape build.ts writes: the binary at the top
// level of a gzipped tar named for the release.
const makeArchive = (dir: string, members: Record<string, string>): { bytes: Uint8Array; name: string } => {
  const src = join(dir, "src");
  mkdirSync(src);
  for (const [name, body] of Object.entries(members)) {
    writeFileSync(join(src, name), body);
    chmodSync(join(src, name), 0o755);
  }
  const name = "kaneo_linux_amd64.tar.gz";
  const out = join(dir, name);
  const r = Bun.spawnSync(["tar", "-czf", out, "-C", src, ...Object.keys(members)]);
  if (r.exitCode !== 0) throw new Error(`fixture tar failed: ${r.stderr.toString()}`);
  return { bytes: readFileSync(out), name };
};

const sumsFor = (bytes: Uint8Array, name: string): string =>
  `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;

type Route = string | Uint8Array | { json: unknown } | { status: number };

// path → response; every request's path is recorded so a test can prove a
// step never reached the network.
const releaseServer = (routes: Record<string, Route>) => {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      const route = routes[path];
      if (route === undefined) return new Response("not found", { status: 404 });
      if (typeof route === "string") return new Response(route);
      if (route instanceof Uint8Array) return new Response(route);
      if ("json" in route) return Response.json(route.json);
      return new Response("error", { status: route.status });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits };
};

// The fixture release: tag v9.9.9 carrying a binary that reports 9.9.9.
const fixtureRelease = (dir: string) => {
  const archive = makeArchive(dir, { kaneo: '#!/bin/sh\necho "kaneo version 9.9.9"\n' });
  return { archive, sums: sumsFor(archive.bytes, archive.name) };
};

const OPTS = { os: "linux", arch: "x64", log: () => {} };

describe("upgrade", () => {
  test("replaces the binary with the pinned release", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const { archive, sums } = fixtureRelease(dir);
    const server = releaseServer({
      "/dl/v9.9.9/kaneo_linux_amd64.tar.gz": archive.bytes,
      "/dl/v9.9.9/checksums.txt": sums,
    });

    const result = await upgrade({
      ...OPTS,
      target,
      version: "v9.9.9",
      releaseBase: `${server.url}/dl`,
    });

    expect(result).toEqual({ upgraded: true, from: "1.0.0", to: "9.9.9", path: target });
    expect(versionOf(target)).toBe("kaneo version 9.9.9");
    // Nothing staged or temporary is left beside the install.
    expect(readdirSync(dir).filter((f) => f.startsWith(".kaneo.incoming"))).toEqual([]);
  });

  test("installs the latest release when no version is pinned", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const { archive, sums } = fixtureRelease(dir);
    const server = releaseServer({
      "/latest": { json: { tag_name: "v9.9.9" } },
      "/dl/v9.9.9/kaneo_linux_amd64.tar.gz": archive.bytes,
      "/dl/v9.9.9/checksums.txt": sums,
    });

    const result = await upgrade({
      ...OPTS,
      target,
      version: "",
      latestUrl: `${server.url}/latest`,
      releaseBase: `${server.url}/dl`,
    });

    expect(result.upgraded).toBe(true);
    expect(server.hits).toContain("/latest");
    expect(versionOf(target)).toBe("kaneo version 9.9.9");
  });

  test("an empty releaseBase uses the default download URL", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const { archive, sums } = fixtureRelease(dir);
    // An empty releaseBase means unset, the way install.sh's
    // ${KANEO_RELEASE_BASE:-...} treats it; the default must be the GitHub
    // releases base, not a relative URL.
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith(".tar.gz")) return new Response(archive.bytes);
      if (url.endsWith("checksums.txt")) return new Response(sums);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const result = await upgrade({ ...OPTS, target, version: "v9.9.9", releaseBase: "", fetchFn });

    expect(result.upgraded).toBe(true);
    expect(urls).toEqual([
      "https://github.com/TakashiAihara/kaneo-cli/releases/download/v9.9.9/kaneo_linux_amd64.tar.gz",
      "https://github.com/TakashiAihara/kaneo-cli/releases/download/v9.9.9/checksums.txt",
    ]);
    expect(versionOf(target)).toBe("kaneo version 9.9.9");
  });

  test("does nothing when the binary already runs the resolved release", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "9.9.9");
    const server = releaseServer({ "/latest": { json: { tag_name: "v9.9.9" } } });

    const result = await upgrade({
      ...OPTS,
      target,
      version: "",
      latestUrl: `${server.url}/latest`,
      releaseBase: `${server.url}/dl`,
    });

    expect(result).toEqual({ upgraded: false, version: "v9.9.9" });
    // The whole point of the check: no archive is fetched for a current install.
    expect(server.hits.some((p) => p.endsWith(".tar.gz"))).toBe(false);
    expect(versionOf(target)).toBe("kaneo version 9.9.9");
  });

  test("refuses a target that is not a kaneo binary before any download", async () => {
    const dir = scratch();
    const target = join(dir, "kaneo");
    writeFileSync(target, '#!/bin/sh\necho "hello"\n');
    chmodSync(target, 0o755);
    const server = releaseServer({});

    await expect(upgrade({ ...OPTS, target, version: "v9.9.9", releaseBase: `${server.url}/dl` })).rejects.toThrow(
      "not a runnable kaneo binary",
    );
    expect(server.hits).toEqual([]);
    expect(readFileSync(target, "utf8")).toContain("hello");
  });

  test("refuses when the archive checksum does not match", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const { archive } = fixtureRelease(dir);
    const server = releaseServer({
      "/dl/v9.9.9/kaneo_linux_amd64.tar.gz": archive.bytes,
      "/dl/v9.9.9/checksums.txt": sumsFor(new Uint8Array([1, 2, 3]), "kaneo_linux_amd64.tar.gz"),
    });

    await expect(upgrade({ ...OPTS, target, version: "v9.9.9", releaseBase: `${server.url}/dl` })).rejects.toThrow(
      "checksum mismatch for kaneo_linux_amd64.tar.gz",
    );
    expect(versionOf(target)).toBe("kaneo version 1.0.0");
  });

  test("refuses an archive the checksums do not list", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const { archive } = fixtureRelease(dir);
    const server = releaseServer({
      "/dl/v9.9.9/kaneo_linux_amd64.tar.gz": archive.bytes,
      "/dl/v9.9.9/checksums.txt": "0".repeat(64) + "  kaneo_linux_arm64.tar.gz\n",
    });

    await expect(upgrade({ ...OPTS, target, version: "v9.9.9", releaseBase: `${server.url}/dl` })).rejects.toThrow(
      "kaneo_linux_amd64.tar.gz is not listed in checksums.txt",
    );
    expect(versionOf(target)).toBe("kaneo version 1.0.0");
  });

  test("refuses when the archive is not there", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const server = releaseServer({});

    await expect(upgrade({ ...OPTS, target, version: "v9.9.9", releaseBase: `${server.url}/dl` })).rejects.toThrow(
      "failed with 404",
    );
    expect(versionOf(target)).toBe("kaneo version 1.0.0");
  });

  test("refuses an archive that has no kaneo binary", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const archive = makeArchive(dir, { "README.md": "nothing here\n" });
    const server = releaseServer({
      "/dl/v9.9.9/kaneo_linux_amd64.tar.gz": archive.bytes,
      "/dl/v9.9.9/checksums.txt": sumsFor(archive.bytes, archive.name),
    });

    await expect(upgrade({ ...OPTS, target, version: "v9.9.9", releaseBase: `${server.url}/dl` })).rejects.toThrow(
      "the archive did not contain a kaneo binary",
    );
    expect(versionOf(target)).toBe("kaneo version 1.0.0");
    expect(readdirSync(dir).filter((f) => f.startsWith(".kaneo.incoming"))).toEqual([]);
  });

  test("refuses a staged binary that does not answer as kaneo", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const archive = makeArchive(dir, { kaneo: '#!/bin/sh\necho "garbage"\n' });
    const server = releaseServer({
      "/dl/v9.9.9/kaneo_linux_amd64.tar.gz": archive.bytes,
      "/dl/v9.9.9/checksums.txt": sumsFor(archive.bytes, archive.name),
    });

    await expect(upgrade({ ...OPTS, target, version: "v9.9.9", releaseBase: `${server.url}/dl` })).rejects.toThrow(
      "not a runnable kaneo binary",
    );
    // The failed probe must not leave the staged file beside the install.
    expect(versionOf(target)).toBe("kaneo version 1.0.0");
    expect(readdirSync(dir).filter((f) => f.startsWith(".kaneo.incoming"))).toEqual([]);
  });

  test("refuses a platform with no release before any download", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const server = releaseServer({});

    await expect(
      upgrade({ ...OPTS, os: "win32", target, version: "v9.9.9", releaseBase: `${server.url}/dl` }),
    ).rejects.toThrow("unsupported OS: win32");
    expect(server.hits).toEqual([]);
  });

  test("refuses a latest-release answer without a tag", async () => {
    const dir = scratch();
    const target = fakeBinary(dir, "1.0.0");
    const server = releaseServer({ "/latest": { json: { name: "no tag here" } } });

    await expect(
      upgrade({ ...OPTS, target, version: "", latestUrl: `${server.url}/latest`, releaseBase: `${server.url}/dl` }),
    ).rejects.toThrow("did not return a release with a tag_name");
  });
});
