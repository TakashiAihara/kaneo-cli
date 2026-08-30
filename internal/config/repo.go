package config

import (
	"context"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// scpLikePattern matches git's scp-style remote: user@host:owner/repo.
var scpLikePattern = regexp.MustCompile(`^[^/@]+@[^/:]+:/?([^/]+)/([^/]+?)(?:\.git)?/?$`)

// urlPattern matches a remote given as a URL, for the schemes that name a
// hosted repository.
var urlPattern = regexp.MustCompile(`^(?:ssh|git|https?)://(?:[^/@]+@)?[^/]+/([^/]+)/([^/]+?)(?:\.git)?/?$`)

// ParseRemote turns a git remote URL into "owner/repo".
//
// Only hosted forms are accepted: scp-style SSH, and ssh/git/http/https URLs.
// A local path is rejected even though git accepts it as a remote, because its
// trailing components look exactly like owner/repo — /home/me/micoworks/thing
// would otherwise resolve to the micoworks workspace and send writes to a
// board that has nothing to do with it.
func ParseRemote(url string) (string, bool) {
	url = strings.TrimSpace(url)
	if url == "" {
		return "", false
	}

	for _, p := range []*regexp.Regexp{urlPattern, scpLikePattern} {
		if m := p.FindStringSubmatch(url); m != nil {
			owner, repo := m[1], m[2]
			if owner == "" || repo == "" {
				return "", false
			}
			return owner + "/" + repo, true
		}
	}
	return "", false
}

// remoteTimeout bounds the git call. Knowing the remote is a convenience for
// resolving a project, never worth stalling a command over.
const remoteTimeout = 2 * time.Second

// CurrentRepo reports the owner/repo of the git remote in dir.
//
// It is derived from the remote rather than the working copy's path because a
// checkout lives at a different absolute path on every machine, while the
// remote is the same everywhere.
func CurrentRepo(ctx context.Context, dir string) (string, bool) {
	// Bounded independently of the caller's context, and with WaitDelay set:
	// cancelling kills git but Output waits for the stdout pipe to close, and
	// a grandchild that inherited it holds it open. Without this the deadline
	// passes and the call still does not return.
	ctx, cancel := context.WithTimeout(ctx, remoteTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "remote", "get-url", "origin")
	cmd.Dir = dir
	cmd.WaitDelay = 500 * time.Millisecond
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return ParseRemote(string(out))
}
