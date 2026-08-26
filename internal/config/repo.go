package config

import (
	"context"
	"os/exec"
	"regexp"
	"strings"
)

// remotePattern pulls owner and repo out of both SSH and HTTPS remote URLs.
var remotePattern = regexp.MustCompile(`[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$`)

// ParseRemote turns a git remote URL into "owner/repo".
func ParseRemote(url string) (string, bool) {
	m := remotePattern.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil {
		return "", false
	}
	return m[1] + "/" + m[2], true
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
