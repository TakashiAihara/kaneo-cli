// The git remote's owner/repo, used by the repo map and the owner map.

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
