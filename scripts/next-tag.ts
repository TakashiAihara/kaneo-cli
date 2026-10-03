// Prints the tag the next automatic release gets: the next release candidate
// after the highest vX.Y.Z or vX.Y.Z-rc.N tag. Every main push is released as
// a candidate, and a final version is only ever cut by hand.

const SHAPE = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

// major, minor, patch, rc. A final version sorts above every release candidate
// of itself, so its rc is Infinity.
type Version = [number, number, number, number];

function parse(tag: string): Version | undefined {
  const m = tag.trim().match(SHAPE);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
}

const compare = (a: Version, b: Version) => {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

export function nextTag(tags: string[]): string {
  const versions = tags.map(parse).filter((v): v is Version => v !== undefined);
  if (versions.length === 0) throw new Error("no vX.Y.Z or vX.Y.Z-rc.N tag to count from");
  const [major, minor, patch, rc] = versions.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
  return rc === Infinity ? `v${major}.${minor}.${patch + 1}-rc.1` : `v${major}.${minor}.${patch}-rc.${rc + 1}`;
}

if (import.meta.main) {
  const git = Bun.spawnSync(["git", "tag", "--list", "v*"]);
  if (git.exitCode !== 0) {
    console.error("git tag:", git.stderr.toString());
    process.exit(1);
  }
  try {
    console.log(nextTag(git.stdout.toString().split("\n")));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
