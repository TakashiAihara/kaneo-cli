// The git remote's owner/repo, used by the repo map and the owner map, and the
// owner/repo a caller names.

const SCP_LIKE = /^[^/@]+@[^/:]+:\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const URL_LIKE = /^(?:ssh|git|https?):\/\/(?:[^/@]+@)?[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

// Only hosted forms are accepted: scp-style SSH, and ssh/git/http/https URLs.
// A local path is rejected even though git accepts it as a remote, because its
// trailing components look exactly like owner/repo — /home/me/acme/thing would
// otherwise resolve to the acme workspace and send writes to a board that has
// nothing to do with it.
export const parseRemote = (remote: string): string => {
  const url = remote.trim();
  if (url === "") return "";
  for (const pattern of [URL_LIKE, SCP_LIKE]) {
    const match = pattern.exec(url);
    const owner = match?.[1];
    const repo = match?.[2];
    if (owner !== undefined && repo !== undefined && owner !== "" && repo !== "") return `${owner}/${repo}`;
  }
  return "";
};

// GitHub's own charset, so a value that could only be a typo (`../x`,
// `host:owner/name` without a user, `a@b/c`) is refused rather than looked up
// and reported as not registered, which reads as an answer.
const OWNER_REPO = /^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;

// The owner/repo a caller named, or "" when the value names no repository.
//
// Both spellings are taken because the maps are keyed by one and a person has
// the other in front of them: `git remote get-url` prints a URL, and pasting
// that back in should not have to be edited down to it first.
//
// The remotes are read first, since a scp-style one holds a slash as well and
// would otherwise pass for an owner and a repository named after a host and a
// path.
export const parseRepo = (value: string): string => {
  const remote = parseRemote(value);
  if (remote !== "") return remote;
  const match = OWNER_REPO.exec(value);
  return match === null ? "" : `${match[1]}/${match[2]}`;
};

// Knowing the remote is a convenience for resolving a project, never worth
// stalling a command over, so the call is bounded on its own.
const REMOTE_TIMEOUT_MS = 2000;

// The owner/repo of dir's origin remote, or "" when there is none to read.
//
// It comes from the remote rather than the working copy's path, because a
// checkout lives at a different absolute path on every machine while the remote
// is the same everywhere. git's own complaint goes nowhere: a directory that is
// not a repository is an ordinary answer here, not a failure, and a machine
// with no git at all is the same answer.
export const currentRepo = (dir: string): string => {
  let remote: string;
  try {
    const git = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd: dir,
      timeout: REMOTE_TIMEOUT_MS,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!git.success) return "";
    remote = git.stdout.toString();
  } catch {
    // Spawning is what fails when there is no git on PATH, and the repository
    // map is a convenience layer: without git to read a remote, the layers above
    // it are still an answer and the command is still worth running.
    return "";
  }
  return parseRemote(remote);
};
