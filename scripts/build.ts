import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Builds a standalone binary for every release target and packs each one the
// way install.sh expects: dist/kaneo_<os>_<arch>.tar.gz holding kaneo, README.md
// and LICENSE, plus dist/checksums.txt in sha256sum format. The names are the
// ones the Go releases used, so install.sh and existing installs keep working.
//
// Usage: bun scripts/build.ts [version]   (version defaults to "dev")

const TARGETS = [
  { os: "linux", arch: "amd64", bun: "bun-linux-x64" },
  { os: "linux", arch: "arm64", bun: "bun-linux-arm64" },
  { os: "darwin", arch: "amd64", bun: "bun-darwin-x64" },
  { os: "darwin", arch: "arm64", bun: "bun-darwin-arm64" },
];

const version = process.argv[2] ?? "dev";
const dist = new URL("../dist/", import.meta.url).pathname;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const sums: string[] = [];
for (const t of TARGETS) {
  const stage = `${dist}${t.os}_${t.arch}/`;
  mkdirSync(stage);
  await $`bun build src/index.ts --compile --minify --target=${t.bun} --define KANEO_VERSION=${JSON.stringify(version)} --outfile ${stage}kaneo`.quiet();
  await $`cp README.md LICENSE ${stage}`;
  const archive = `kaneo_${t.os}_${t.arch}.tar.gz`;
  await $`tar -czf ${dist}${archive} -C ${stage} kaneo README.md LICENSE`;
  rmSync(stage, { recursive: true });
  sums.push(`${createHash("sha256").update(readFileSync(`${dist}${archive}`)).digest("hex")}  ${archive}`);
  console.log(archive);
}
writeFileSync(`${dist}checksums.txt`, sums.join("\n") + "\n");
