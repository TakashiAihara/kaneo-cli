package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func envFrom(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestPrecedence(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "repo", "packages", "api")
	writeFile(t, filepath.Join(home, "repo", LocalFileName), `{"workspace":"ws-local","project":"proj-local"}`)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	g := &Global{
		DefaultProfile: "p",
		Profiles: map[string]Profile{"p": {
			APIURL: "https://profile.example", APIKey: "key-profile",
			WorkspaceID: "ws-profile", ProjectID: "proj-profile",
		}},
		Repos: map[string]string{"owner/repo": "proj-repomap"},
	}
	base := Inputs{Dir: dir, Home: home, Global: g, Repo: "owner/repo"}

	t.Run("flag beats everything", func(t *testing.T) {
		in := base
		in.Env = envFrom(map[string]string{"KANEO_PROJECT": "proj-env"})
		in.Flags = Flags{ProjectID: "proj-flag"}
		r := Resolve(in)
		if r.ProjectID != "proj-flag" {
			t.Errorf("project = %q, want proj-flag", r.ProjectID)
		}
		if r.Origin["project"] != SourceFlag {
			t.Errorf("origin = %q, want flag", r.Origin["project"])
		}
	})

	t.Run("env beats local file", func(t *testing.T) {
		in := base
		in.Env = envFrom(map[string]string{"KANEO_PROJECT": "proj-env"})
		r := Resolve(in)
		if r.ProjectID != "proj-env" {
			t.Errorf("project = %q, want proj-env", r.ProjectID)
		}
		if r.Origin["project"] != SourceEnv {
			t.Errorf("origin = %q, want env", r.Origin["project"])
		}
	})

	t.Run("local file beats profile", func(t *testing.T) {
		r := Resolve(base)
		if r.ProjectID != "proj-local" {
			t.Errorf("project = %q, want proj-local", r.ProjectID)
		}
		if r.WorkspaceID != "ws-local" {
			t.Errorf("workspace = %q, want ws-local", r.WorkspaceID)
		}
		if r.Origin["project"] != SourceLocal {
			t.Errorf("origin = %q, want local", r.Origin["project"])
		}
	})

	t.Run("profile beats repo map", func(t *testing.T) {
		in := base
		in.Dir = t.TempDir() // no .kaneo.json anywhere
		in.Home = in.Dir
		r := Resolve(in)
		if r.ProjectID != "proj-profile" {
			t.Errorf("project = %q, want proj-profile", r.ProjectID)
		}
		if r.Origin["project"] != SourceProfile {
			t.Errorf("origin = %q, want profile", r.Origin["project"])
		}
	})

	t.Run("repo map is the last resort for project", func(t *testing.T) {
		in := base
		in.Dir = t.TempDir()
		in.Home = in.Dir
		in.Global = &Global{Repos: map[string]string{"owner/repo": "proj-repomap"}}
		r := Resolve(in)
		if r.ProjectID != "proj-repomap" {
			t.Errorf("project = %q, want proj-repomap", r.ProjectID)
		}
		if r.Origin["project"] != SourceRepoMap {
			t.Errorf("origin = %q, want repo-map", r.Origin["project"])
		}
	})

	t.Run("repo map never supplies a workspace", func(t *testing.T) {
		in := base
		in.Dir = t.TempDir()
		in.Home = in.Dir
		in.Global = &Global{Repos: map[string]string{"owner/repo": "proj-repomap"}}
		r := Resolve(in)
		if r.WorkspaceID != "" {
			t.Errorf("workspace = %q, want empty", r.WorkspaceID)
		}
		if r.Origin["workspace"] != SourceUnset {
			t.Errorf("origin = %q, want unset", r.Origin["workspace"])
		}
	})

	t.Run("api url falls back to the hosted default", func(t *testing.T) {
		in := base
		in.Global = &Global{}
		r := Resolve(in)
		if r.APIURL != DefaultAPIURL {
			t.Errorf("api url = %q, want %q", r.APIURL, DefaultAPIURL)
		}
		if r.Origin["api_url"] != SourceDefault {
			t.Errorf("origin = %q, want default", r.Origin["api_url"])
		}
	})
}

// A .kaneo.json is committed, so a credential written into it would leak with
// the repo. The guarantee is structural: Local carries exactly two serialised
// fields and neither is a secret. Asserting on a resolved value instead would
// be vacuous, because a Local field that MergeLocals does not copy can never
// reach the resolver at all.
func TestLocalCarriesOnlyNonSecretFields(t *testing.T) {
	want := map[string]bool{"workspace": true, "project": true}

	typ := reflect.TypeOf(Local{})
	got := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		tag := typ.Field(i).Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name == "" || name == "-" {
			continue
		}
		got[name] = true
	}

	for name := range got {
		if !want[name] {
			t.Errorf("Local gained serialised field %q; .kaneo.json is committed, so it must stay free of secrets", name)
		}
	}
	for name := range want {
		if !got[name] {
			t.Errorf("Local lost serialised field %q", name)
		}
	}
}

// MergeLocals is the only way a Local reaches the resolver, so it is the other
// half of the same guarantee: it must copy nothing beyond those two fields.
func TestMergeLocalsCopiesOnlyWorkspaceAndProject(t *testing.T) {
	merged := MergeLocals([]Local{{Workspace: "ws", Project: "proj", Path: "/a/.kaneo.json"}})

	typ := reflect.TypeOf(merged)
	val := reflect.ValueOf(merged)
	allowed := map[string]bool{"Workspace": true, "Project": true, "Path": true}
	for i := 0; i < typ.NumField(); i++ {
		name := typ.Field(i).Name
		if allowed[name] {
			continue
		}
		if !val.Field(i).IsZero() {
			t.Errorf("MergeLocals propagated unexpected field %q", name)
		}
	}
}

func TestWalkUpNearestWinsAndParentFillsGaps(t *testing.T) {
	home := t.TempDir()
	child := filepath.Join(home, "mono", "apps", "web")
	writeFile(t, filepath.Join(home, "mono", LocalFileName), `{"workspace":"ws-root","project":"proj-root"}`)
	writeFile(t, filepath.Join(child, LocalFileName), `{"project":"proj-child"}`)

	r := Resolve(Inputs{Dir: child, Home: home, Global: &Global{}})
	if r.ProjectID != "proj-child" {
		t.Errorf("project = %q, want proj-child (nearest wins)", r.ProjectID)
	}
	if r.WorkspaceID != "ws-root" {
		t.Errorf("workspace = %q, want ws-root (parent fills the gap)", r.WorkspaceID)
	}
}

func TestWalkUpStopsAtHome(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	dir := filepath.Join(home, "repo")
	// Above $HOME. If the walk overshoots it will pick this up.
	writeFile(t, filepath.Join(root, LocalFileName), `{"project":"proj-above-home"}`)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	r := Resolve(Inputs{Dir: dir, Home: home, Global: &Global{}})
	if r.ProjectID != "" {
		t.Errorf("project = %q, want empty; the walk went past $HOME", r.ProjectID)
	}
}

// A broken config must not stop the run: the layer below it is still an answer.
func TestMalformedLocalFileIsSkipped(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "a", "b")
	writeFile(t, filepath.Join(home, "a", LocalFileName), `{"project":"proj-parent"}`)
	writeFile(t, filepath.Join(dir, LocalFileName), `{not json`)

	r := Resolve(Inputs{Dir: dir, Home: home, Global: &Global{}})
	if r.ProjectID != "proj-parent" {
		t.Errorf("project = %q, want proj-parent", r.ProjectID)
	}
}

func TestParseRemote(t *testing.T) {
	tests := map[string]string{
		"https://github.com/TakashiAihara/kaneo-cli.git": "TakashiAihara/kaneo-cli",
		"https://github.com/TakashiAihara/kaneo-cli":     "TakashiAihara/kaneo-cli",
		"git@github.com:TakashiAihara/kaneo-cli.git":     "TakashiAihara/kaneo-cli",
		"ssh://git@example.com:2222/owner/repo.git":      "owner/repo",
		"git@github.com:TakashiAihara/kaneo-cli.git\n":   "TakashiAihara/kaneo-cli",
	}
	for url, want := range tests {
		got, ok := ParseRemote(url)
		if !ok || got != want {
			t.Errorf("ParseRemote(%q) = %q, %v; want %q", url, got, ok, want)
		}
	}
	if _, ok := ParseRemote("not-a-remote"); ok {
		t.Error("ParseRemote accepted a non-remote string")
	}
}
