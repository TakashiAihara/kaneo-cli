package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ProjectIDs is the value side of the repo map.
//
// A workspace holds any number of projects, and one repository can have work
// on several of them, so the value is a list. It decodes from a bare string as
// well: every config written before this existed holds one, and a config file
// is synced between machines that may not all be running the same build.
type ProjectIDs []string

// UnmarshalJSON accepts either a project id or a list of them.
//
// Empty ids are dropped rather than kept. An empty string is not a project,
// and letting one through would make a repository look configured while every
// request built from it named nothing.
func (p *ProjectIDs) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*p = nil
		if one != "" {
			*p = ProjectIDs{one}
		}
		return nil
	}

	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return fmt.Errorf("repo map value must be a project id or a list of project ids: %w", err)
	}
	out := ProjectIDs{}
	for _, id := range many {
		if id != "" {
			out = append(out, id)
		}
	}
	*p = out
	return nil
}

// MarshalJSON writes anything but a genuine list back as a bare string.
//
// Save rewrites the whole file, so an entry is widened to a list only when it
// holds more than one id. An older build reading the same synced config parses
// every value as a string and fails the whole file on the first one it cannot,
// so every entry that can stay a string does.
//
// That includes the empty one. An entry of "" carries no project, and so does
// [], but only the first is readable by a build that predates this — writing
// [] would make a config that was fine before this ran unreadable afterwards.
func (p ProjectIDs) MarshalJSON() ([]byte, error) {
	if len(p) < 2 {
		one := ""
		if len(p) == 1 {
			one = p[0]
		}
		return json.Marshal(one)
	}
	return json.Marshal([]string(p))
}

// Profile is one named set of connection settings.
type Profile struct {
	APIURL      string `json:"api_url,omitempty"`
	APIKey      string `json:"api_key,omitempty"`
	WorkspaceID string `json:"workspace_id,omitempty"`
	ProjectID   string `json:"project_id,omitempty"`
}

// Global is the user-level config at ~/.config/kaneo/config.json.
type Global struct {
	DefaultProfile string             `json:"default_profile,omitempty"`
	Profiles       map[string]Profile `json:"profiles,omitempty"`

	// Repos maps a git remote's "owner/repo" to the projects it is tied to. It
	// exists for repositories that cannot carry a .kaneo.json — a work repo
	// owned by someone else, for instance. The key is deliberately owner/repo
	// and not a path: a working copy's absolute path differs between machines,
	// so a path key would not survive being synced.
	Repos map[string]ProjectIDs `json:"repos,omitempty"`

	// Owners maps a git remote's owner to a workspace id, so that a rule like
	// "everything under this organisation belongs to that workspace" can be
	// stated once instead of per repository.
	//
	// It supplies a workspace only. A workspace does not imply a project, so
	// the project still comes from .kaneo.json or Repos.
	Owners map[string]string `json:"owners,omitempty"`

	path string
}

// GlobalPath returns the config location, honouring XDG_CONFIG_HOME.
func GlobalPath(home string, env func(string) string) string {
	if x := env("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "kaneo", "config.json")
	}
	return filepath.Join(home, ".config", "kaneo", "config.json")
}

// LoadGlobal reads the config. A missing file is not an error — it is an empty
// config, so a fresh install works with flags and environment alone.
func LoadGlobal(path string) (*Global, error) {
	g := &Global{
		Profiles: map[string]Profile{},
		Repos:    map[string]ProjectIDs{},
		Owners:   map[string]string{},
		path:     path,
	}

	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return g, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(b, g); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if g.Profiles == nil {
		g.Profiles = map[string]Profile{}
	}
	if g.Repos == nil {
		g.Repos = map[string]ProjectIDs{}
	}
	if g.Owners == nil {
		g.Owners = map[string]string{}
	}
	g.path = path
	return g, nil
}

// Save writes the config back with 0600, creating the parent directory.
// The file holds API keys, so the mode is set explicitly rather than left to
// the process umask.
func (g *Global) Save() error {
	if g.path == "" {
		return errors.New("config path is unset")
	}
	if err := os.MkdirAll(filepath.Dir(g.path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')

	// Written to a sibling and renamed over the target. os.WriteFile truncates
	// first, so an interrupted write would leave the config empty and every
	// later run would fail to parse it until someone repaired the file by hand.
	tmp, err := os.CreateTemp(filepath.Dir(g.path), ".config-*.json")
	if err != nil {
		return err
	}
	// Removing the temporary file is best-effort: after a successful rename
	// there is nothing left to remove, and on any earlier failure the write
	// error is the one worth returning.
	defer func() { _ = os.Remove(tmp.Name()) }()

	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), g.path)
}

// Path reports where this config was loaded from.
func (g *Global) Path() string { return g.path }

// WorkspaceForOwner returns the workspace an owner's repositories belong to.
func (g *Global) WorkspaceForOwner(repo string) string {
	owner, _, ok := strings.Cut(repo, "/")
	if !ok || owner == "" {
		return ""
	}
	return g.Owners[owner]
}

// ProjectsForRepo returns the projects a repository is tied to, in the order
// the config lists them.
func (g *Global) ProjectsForRepo(repo string) []string {
	if repo == "" {
		return nil
	}
	ids := g.Repos[repo]
	if len(ids) == 0 {
		return nil
	}
	// Copied so that a caller cannot reach back into the loaded config and
	// change what a later lookup answers.
	return append([]string(nil), ids...)
}

// ActiveProfile returns the profile named by DefaultProfile, or the sole
// profile when exactly one exists and no default was recorded.
func (g *Global) ActiveProfile() (string, Profile, bool) {
	if g.DefaultProfile != "" {
		if p, ok := g.Profiles[g.DefaultProfile]; ok {
			return g.DefaultProfile, p, true
		}
	}
	if len(g.Profiles) == 1 {
		for name, p := range g.Profiles {
			return name, p, true
		}
	}
	return "", Profile{}, false
}

// SetProfile stores a profile, making it the default when none is set yet.
func (g *Global) SetProfile(name string, p Profile) {
	if g.Profiles == nil {
		g.Profiles = map[string]Profile{}
	}
	g.Profiles[name] = p
	if g.DefaultProfile == "" {
		g.DefaultProfile = name
	}
}

// RemoveProfile drops a single profile. Unlike wiping the whole config file,
// this leaves the user's other profiles and repo mappings intact.
func (g *Global) RemoveProfile(name string) bool {
	if _, ok := g.Profiles[name]; !ok {
		return false
	}
	delete(g.Profiles, name)
	if g.DefaultProfile == name {
		g.DefaultProfile = ""
		if len(g.Profiles) == 1 {
			for n := range g.Profiles {
				g.DefaultProfile = n
			}
		}
	}
	return true
}
