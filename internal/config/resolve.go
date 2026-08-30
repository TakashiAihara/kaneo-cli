package config

import (
	"context"
	"os"
)

// DefaultAPIURL is the hosted Kaneo instance. A self-hosted deployment is
// selected through a profile, KANEO_API_URL, or --api-url.
const DefaultAPIURL = "https://cloud.kaneo.app"

// Source names the layer a resolved value came from, so `kaneo context` can
// explain itself and a surprising value can be traced to its origin.
type Source string

const (
	SourceFlag     Source = "flag"
	SourceEnv      Source = "env"
	SourceLocal    Source = "local"   // .kaneo.json
	SourceProfile  Source = "profile" // ~/.config/kaneo/config.json
	SourceRepoMap  Source = "repo-map"
	SourceOwnerMap Source = "owner-map"
	SourceDefault  Source = "default"
	SourceUnset    Source = "unset"
)

// Flags holds the command-line overrides.
type Flags struct {
	APIURL      string
	APIKey      string
	WorkspaceID string
	ProjectID   string
}

// Resolved is the settings a command should act on, plus where each came from.
type Resolved struct {
	APIURL      string
	APIKey      string
	WorkspaceID string
	ProjectID   string

	Origin map[string]Source

	ProfileName string
	LocalPath   string
	Repo        string
}

// Inputs are the surroundings a resolution reads. They are passed in rather
// than probed so that the precedence rules are testable without touching the
// real filesystem or environment.
type Inputs struct {
	Flags  Flags
	Env    func(string) string
	Dir    string
	Home   string
	Global *Global
	Repo   string // owner/repo, empty when not in a git repo
}

// Resolve applies the precedence chain, from strongest to weakest:
//
//	flag > environment > .kaneo.json > active profile > repo map > owner map > default
//
// The last two layers are narrow on purpose. The repo map supplies only a
// project, mapping owner/repo to a project id; the owner map supplies only a
// workspace, mapping an owner to a workspace id. Neither can supply a
// credential.
func Resolve(in Inputs) Resolved {
	r := Resolved{Origin: map[string]Source{}, Repo: in.Repo}

	env := in.Env
	if env == nil {
		env = func(string) string { return "" }
	}

	locals := FindLocals(in.Dir, in.Home)
	local := MergeLocals(locals)
	r.LocalPath = local.Path

	var profile Profile
	if in.Global != nil {
		if name, p, ok := in.Global.ActiveProfile(); ok {
			r.ProfileName, profile = name, p
		}
	}

	pick := func(field string, candidates ...struct {
		value  string
		source Source
	}) string {
		for _, c := range candidates {
			if c.value != "" {
				r.Origin[field] = c.source
				return c.value
			}
		}
		r.Origin[field] = SourceUnset
		return ""
	}
	c := func(value string, source Source) struct {
		value  string
		source Source
	} {
		return struct {
			value  string
			source Source
		}{value, source}
	}

	r.APIURL = pick("api_url",
		c(in.Flags.APIURL, SourceFlag),
		c(env("KANEO_API_URL"), SourceEnv),
		c(profile.APIURL, SourceProfile),
		c(DefaultAPIURL, SourceDefault),
	)
	r.APIKey = pick("api_key",
		c(in.Flags.APIKey, SourceFlag),
		c(env("KANEO_API_KEY"), SourceEnv),
		c(profile.APIKey, SourceProfile),
	)
	var fromOwnerMap string
	if in.Global != nil && in.Repo != "" {
		fromOwnerMap = in.Global.WorkspaceForOwner(in.Repo)
	}
	r.WorkspaceID = pick("workspace",
		c(in.Flags.WorkspaceID, SourceFlag),
		c(env("KANEO_WORKSPACE"), SourceEnv),
		c(local.Workspace, SourceLocal),
		c(profile.WorkspaceID, SourceProfile),
		c(fromOwnerMap, SourceOwnerMap),
	)

	var fromRepoMap string
	if in.Global != nil && in.Repo != "" {
		fromRepoMap = in.Global.Repos[in.Repo]
	}
	r.ProjectID = pick("project",
		c(in.Flags.ProjectID, SourceFlag),
		c(env("KANEO_PROJECT"), SourceEnv),
		c(local.Project, SourceLocal),
		c(profile.ProjectID, SourceProfile),
		c(fromRepoMap, SourceRepoMap),
	)

	return r
}

// ResolveFromEnvironment builds Inputs from the real process surroundings.
func ResolveFromEnvironment(ctx context.Context, flags Flags) (Resolved, *Global, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Resolved{}, nil, err
	}
	dir, err := os.Getwd()
	if err != nil {
		return Resolved{}, nil, err
	}
	g, err := LoadGlobal(GlobalPath(home, os.Getenv))
	if err != nil {
		return Resolved{}, nil, err
	}
	repo, _ := CurrentRepo(ctx, dir)

	return Resolve(Inputs{
		Flags:  flags,
		Env:    os.Getenv,
		Dir:    dir,
		Home:   home,
		Global: g,
		Repo:   repo,
	}), g, nil
}
