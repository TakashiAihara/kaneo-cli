package config

import (
	"context"
	"os/exec"
	"regexp"
	"strings"
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

// CurrentRepo reports the owner/repo of the git remote in dir.
//
// It is derived from the remote rather than the working copy's path because a
// checkout lives at a different absolute path on every machine, while the
// remote is the same everywhere.
func CurrentRepo(ctx context.Context, dir string) (string, bool) {
	cmd := exec.CommandContext(ctx, "git", "remote", "get-url", "origin")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return ParseRemote(string(out))
}
