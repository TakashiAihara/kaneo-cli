// The git remote's owner/repo, used by the repo map and the owner map, and the
// owner/repo a caller names.

const SCP_LIKE = /^[^/@]+@[^/:]+:\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
// No user, so `host:owner/name` as git prints it for a remote written that way.
// For a value without `://`, git treats it as scp-style ssh whenever no `/`
// comes before the first `:`, so a slash after the colon does not make it a
// path (a value with a scheme is taken by URL_LIKE first). A single-letter host is still
// refused: only Git for Windows reads `C:x/y` as a drive, but a checkout made on
// Windows should not have its drive path read as a repository.
const SCP_NO_USER = /^[^/:]{2,}:\/?([^/:]+)\/([^/]+?)(?:\.git)?\/?$/;
const URL_LIKE = /^(?:ssh|git|https?):\/\/(?:[^/@]+@)?[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

// Close to GitHub's charset, so a value that names no repository (`../x`,
// `x/..`, `a@b/c`) is refused rather than looked up and reported as not
// registered, which reads as an answer. An owner may start with `~`: git
// documents `host:~user/path`, and sourcehut names every repository that way.
// A `~` alone, a home directory, is still refused; `~acme` cannot be mistaken
// for another host's owner, since no GitHub owner starts with `~`.
const OWNER = /^~?[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const OWNER_REPO = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

// owner/repo when both parts are in the charset above, or "".
const named = (owner: string, repo: string): string => (OWNER.test(owner) && REPO.test(repo) ? `${owner}/${repo}` : "");

// Only hosted forms are accepted: scp-style SSH, and ssh/git/http/https URLs.
// A local path is rejected even though git accepts it as a remote, because its
// trailing components look exactly like owner/repo — /home/me/acme/thing would
// otherwise resolve to the acme workspace and send writes to a board that has
// nothing to do with it. What a form leaves as owner/repo is held to the same
// charset as a typed one, so `host:../x` is not looked up as a repository.
//
// The host is dropped: the repo and owner maps are keyed by owner/repo alone,
// so the user-less scp form is no harder to read than the others.
const parseRemote = (remote: string): string => {
  const url = remote.trim();
  if (url === "") return "";
  for (const pattern of [URL_LIKE, SCP_LIKE, SCP_NO_USER]) {
    const match = pattern.exec(url);
    // Where two forms match the same value they leave the same owner/repo, so
    // the first one that matches decides.
    if (match !== null) return named(match[1]!, match[2]!);
  }
  return "";
};

// The owner/repo a caller named, or "" when the value names no repository.
//
// Both spellings are taken because the maps are keyed by one and a person has
// the other in front of them: `git remote get-url` prints a URL, and pasting
// that back in should not have to be edited down to it first.
export const parseRepo = (value: string): string => {
  const remote = parseRemote(value);
  if (remote !== "") return remote;
  const match = OWNER_REPO.exec(value.trim());
  return match === null ? "" : named(match[1]!, match[2]!);
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
//
// env is what git runs with; a caller that changes the environment git should
// see passes it, because Bun.spawnSync does not pick up later process.env edits.
export const currentRepo = (dir: string, env: Record<string, string | undefined> = process.env): string => {
  let remote: string;
  try {
    const git = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd: dir,
      env,
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
