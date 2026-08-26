// Package cli builds the command tree.
package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
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

// Project returns the resolved project, or an actionable error.
func (a *App) Project() (string, error) {
	if a.Cfg.ProjectID == "" {
		return "", errors.New("no project: pass --project, set KANEO_PROJECT, or add one to .kaneo.json")
	}
	return a.Cfg.ProjectID, nil
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
