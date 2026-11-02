import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "install.sh");
const roots: string[] = [];

afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Stage = "download" | "verify";

// The signal goes to the shell alone, so it takes effect once the child that
// is running returns; the fake children linger for a second to hold that
// window open. "download" lingers inside curl (temp dir exists, nothing staged);
// "verify" lingers inside the staged binary's --version (staged file exists).
async function interrupted(signal: "SIGINT" | "SIGTERM", stage: Stage) {
    const root = mkdtempSync(join(tmpdir(), "install-sig-"));
    roots.push(root);
    const bin = join(root, "bin");
    const tmp = join(root, "tmp");
    const fixtures = join(root, "fixtures");
    const installDir = join(root, "install");
    for (const d of [bin, tmp, fixtures]) mkdirSync(d);

    const os = Bun.spawnSync(["uname", "-s"]).stdout.toString().trim() === "Darwin" ? "darwin" : "linux";
    const m = Bun.spawnSync(["uname", "-m"]).stdout.toString().trim();
    const arch = m === "x86_64" || m === "amd64" ? "amd64" : "arm64";
    const archive = `kaneo_${os}_${arch}.tar.gz`;

    const log = join(root, "calls.log");
    const started = join(root, "binary-started");
    writeFileSync(log, "");

    let curlBody: string;
    if (stage === "download") {
        curlBody = `echo "$*" >> '${log}'\nsleep 1\nexit 1\n`;
    } else {
        const src = join(root, "src");
        mkdirSync(src);
        writeFileSync(join(src, "kaneo"), `#!/bin/sh\necho up > '${started}'\nsleep 1\necho v9.9.9\n`);
        chmodSync(join(src, "kaneo"), 0o755);
        Bun.spawnSync(["tar", "-czf", join(fixtures, archive), "-C", src, "kaneo"]);
        const digest = new Bun.CryptoHasher("sha256").update(readFileSync(join(fixtures, archive))).digest("hex");
        writeFileSync(join(fixtures, "checksums.txt"), `${digest}  ${archive}\n`);
        curlBody = `echo "$*" >> '${log}'\nwhile [ $# -gt 0 ]; do case $1 in -o) out=$2; shift;; http*) url=$1;; esac; shift; done\ncp '${fixtures}'/"$(basename "$url")" "$out"\n`;
    }
    const curl = join(bin, "curl");
    writeFileSync(curl, `#!/bin/sh\n${curlBody}`);
    chmodSync(curl, 0o755);

    const proc = Bun.spawn(["sh", script], {
        env: {
            PATH: `${bin}:${process.env.PATH}`,
            TMPDIR: tmp,
            HOME: root,
            KANEO_VERSION: "v0.0.0",
            KANEO_INSTALL_DIR: installDir,
            KANEO_RELEASE_BASE: "http://example.invalid",
        },
        stdout: "pipe",
        stderr: "pipe",
    });

    const ready = stage === "download" ? () => readFileSync(log, "utf8") !== "" : () => existsSync(started);
    for (let i = 0; i < 100 && !ready(); i++) await Bun.sleep(50);
    expect(ready()).toBe(true);

    proc.kill(signal);
    const code = await proc.exited;
    return {
        code,
        calls: readFileSync(log, "utf8").trim().split("\n"),
        tmpLeft: readdirSync(tmp),
        installLeft: existsSync(installDir) ? readdirSync(installDir) : [],
    };
}

test("SIGINT during the download exits 130, cleans up and downloads nothing more", async () => {
    const r = await interrupted("SIGINT", "download");
    expect(r.code).toBe(130);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain("kaneo_");
    expect(r.tmpLeft).toEqual([]);
});

test("SIGTERM during the download exits 143, cleans up and downloads nothing more", async () => {
    const r = await interrupted("SIGTERM", "download");
    expect(r.code).toBe(143);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toContain("kaneo_");
    expect(r.tmpLeft).toEqual([]);
});

test("SIGTERM while the staged binary runs removes it and installs nothing", async () => {
    const r = await interrupted("SIGTERM", "verify");
    expect(r.code).toBe(143);
    expect(r.tmpLeft).toEqual([]);
    expect(r.installLeft).toEqual([]);
});

test("SIGINT while the staged binary runs exits 130 without installing", async () => {
    const r = await interrupted("SIGINT", "verify");
    expect(r.code).toBe(130);
    expect(r.installLeft).toEqual([]);
});
