// Package cli builds the command tree.
package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/TakashiAihara/kaneo-cli/internal/api"
	"github.com/TakashiAihara/kaneo-cli/internal/config"
	"github.com/TakashiAihara/kaneo-cli/internal/output"
)

// App carries everything a command needs. It is built once in the root
// command's PersistentPreRun and read by the leaves.
type App struct {
	Cfg     config.Resolved
	Global  *config.Global
	Out     *output.Writer
	Timeout time.Duration
}

// ErrNoAPIKey is returned when nothing supplied a credential.
var ErrNoAPIKey = errors.New("no API key: set KANEO_API_KEY, or pass --api-key")

// Client builds an API client from the resolved settings.
func (a *App) Client() (*api.Client, error) {
	if a.Cfg.APIKey == "" {
		return nil, ErrNoAPIKey
	}
	return api.New(a.Cfg.APIURL, a.Cfg.APIKey, a.Timeout), nil
}

// Workspace returns the resolved workspace, or an actionable error.
func (a *App) Workspace() (string, error) {
	if a.Cfg.WorkspaceID == "" {
		return "", errors.New("no workspace: pass --workspace, set KANEO_WORKSPACE, or add one to .kaneo.json")
	}
	return a.Cfg.WorkspaceID, nil
}

// Projects returns every project the settings resolved to.
//
// Only the repo map can name more than one; a flag, the environment, a
// .kaneo.json and a profile each name exactly one.
func (a *App) Projects() ([]string, error) {
	if len(a.Cfg.ProjectIDs) == 0 {
		return nil, errors.New("no project: pass --project, set KANEO_PROJECT, or add one to .kaneo.json")
	}
	return a.Cfg.ProjectIDs, nil
}

// Project returns the single project a command should act on.
//
// A repository tied to several projects has no single answer, and taking the
// first would write to a board nobody named. The repo map states no order of
// precedence among its entries, so there is nothing to read a default out of;
// the caller has to say which. This is the same reason the owner map supplies
// a workspace but never a project.
func (a *App) Project() (string, error) {
	ids, err := a.Projects()
	if err != nil {
		return "", err
	}
	if len(ids) > 1 {
		return "", fmt.Errorf(
			"%s is mapped to %d projects (%s): pass --project or set KANEO_PROJECT to choose one",
			or(a.Cfg.Repo, "this repository"), len(ids), strings.Join(ids, ", "))
	}
	return ids[0], nil
}

// Context returns a context bounded by the configured timeout.
func (a *App) Context() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), a.Timeout)
}

// debugf writes to stderr only when KANEO_DEBUG is set. It exists so the
// fail-open commands can explain themselves without breaking their contract of
// producing no output.
func debugf(format string, args ...any) {
	if os.Getenv("KANEO_DEBUG") == "" {
		return
	}
	fmt.Fprintf(os.Stderr, "kaneo: "+format+"\n", args...)
}
