package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every config written before a repository could hold more than one project
// carries a bare string, and the file is synced between machines that may not
// all run the same build. Reading one has to keep working.
func TestRepoMapReadsAStringValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	writeFile(t, path, `{"repos":{"owner/repo":"proj-one"}}`)

	g, err := LoadGlobal(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(g.ProjectsForRepo("owner/repo"), ","); got != "proj-one" {
		t.Errorf("projects = %q, want proj-one", got)
	}
}

func TestRepoMapReadsAListValue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	writeFile(t, path, `{"repos":{"owner/repo":["proj-one","proj-two"]}}`)

	g, err := LoadGlobal(path)
	if err != nil {
		t.Fatal(err)
	}
	got := g.ProjectsForRepo("owner/repo")
	if len(got) != 2 || got[0] != "proj-one" || got[1] != "proj-two" {
		t.Errorf("projects = %v, want [proj-one proj-two] in the order the config lists them", got)
	}
}

// The two shapes have to reach the resolver as the same thing, or a mapping
// would mean something different depending on how it was written.
func TestRepoMapStringAndSingletonListResolveAlike(t *testing.T) {
	home := t.TempDir()
	for _, body := range []string{`"proj-one"`, `["proj-one"]`} {
		path := filepath.Join(t.TempDir(), "config.json")
		writeFile(t, path, `{"repos":{"owner/repo":`+body+`}}`)
		g, err := LoadGlobal(path)
		if err != nil {
			t.Fatal(err)
		}
		r := Resolve(Inputs{Dir: home, Home: home, Global: g, Repo: "owner/repo"})
		if got := strings.Join(r.ProjectIDs, ","); got != "proj-one" {
			t.Errorf("%s: projects = %q, want proj-one", body, got)
		}
		if r.Origin["project"] != SourceRepoMap {
			t.Errorf("%s: origin = %q, want repo-map", body, r.Origin["project"])
		}
	}
}

func TestRepoMapListReachesTheResolver(t *testing.T) {
	home := t.TempDir()
	g := &Global{Repos: map[string]ProjectIDs{"owner/repo": {"proj-one", "proj-two"}}}

	r := Resolve(Inputs{Dir: home, Home: home, Global: g, Repo: "owner/repo"})
	if got := strings.Join(r.ProjectIDs, ","); got != "proj-one,proj-two" {
		t.Errorf("projects = %q, want both", got)
	}
	if r.Origin["project"] != SourceRepoMap {
		t.Errorf("origin = %q, want repo-map", r.Origin["project"])
	}
}

// A flag names one project, so it has to reduce the list to that one. Without
// this there would be no way to act on a single project in a repository that
// is mapped to several.
func TestFlagNarrowsAListToOne(t *testing.T) {
	home := t.TempDir()
	g := &Global{Repos: map[string]ProjectIDs{"owner/repo": {"proj-one", "proj-two"}}}

	for _, tc := range []struct {
		name string
		in   Inputs
		want Source
	}{
		{"flag", Inputs{Dir: home, Home: home, Global: g, Repo: "owner/repo",
			Flags: Flags{ProjectID: "proj-chosen"}}, SourceFlag},
		{"env", Inputs{Dir: home, Home: home, Global: g, Repo: "owner/repo",
			Env: envFrom(map[string]string{"KANEO_PROJECT": "proj-chosen"})}, SourceEnv},
	} {
		r := Resolve(tc.in)
		if got := strings.Join(r.ProjectIDs, ","); got != "proj-chosen" {
			t.Errorf("%s: projects = %q, want just proj-chosen", tc.name, got)
		}
		if r.Origin["project"] != tc.want {
			t.Errorf("%s: origin = %q, want %q", tc.name, r.Origin["project"], tc.want)
		}
	}
}

// An unregistered repository has always resolved to no project at all, which
// is what makes board produce nothing there instead of an error.
func TestUnregisteredRepoResolvesToNoProject(t *testing.T) {
	home := t.TempDir()
	g := &Global{Repos: map[string]ProjectIDs{"owner/repo": {"proj-one", "proj-two"}}}

	r := Resolve(Inputs{Dir: home, Home: home, Global: g, Repo: "someone-else/other"})
	if len(r.ProjectIDs) != 0 {
		t.Errorf("projects = %v, want none", r.ProjectIDs)
	}
	if r.Origin["project"] != SourceUnset {
		t.Errorf("origin = %q, want unset", r.Origin["project"])
	}
}

// An empty list and an empty string are not projects. Letting either through
// would make a repository look configured while every request built from it
// named nothing.
func TestEmptyValuesAreTreatedAsUnset(t *testing.T) {
	for name, body := range map[string]string{
		"empty list":      `{"repos":{"owner/repo":[]}}`,
		"empty string":    `{"repos":{"owner/repo":""}}`,
		"list of blanks":  `{"repos":{"owner/repo":["",""]}}`,
		"blank among ids": `{"repos":{"owner/repo":["","proj-one"]}}`,
		"no entry at all": `{"repos":{}}`,
	} {
		path := filepath.Join(t.TempDir(), "config.json")
		writeFile(t, path, body)
		g, err := LoadGlobal(path)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		got := g.ProjectsForRepo("owner/repo")
		want := ""
		if name == "blank among ids" {
			want = "proj-one"
		}
		if strings.Join(got, ",") != want {
			t.Errorf("%s: projects = %v, want %q", name, got, want)
		}
	}
}

func TestMalformedRepoMapValueIsAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	writeFile(t, path, `{"repos":{"owner/repo":{"project":"proj-one"}}}`)

	if _, err := LoadGlobal(path); err == nil {
		t.Error("a repo map value that is neither an id nor a list was accepted")
	}
}

// Save rewrites the whole file. Widening a lone id to a list would edit
// mappings this run never touched, and an older build reading the same synced
// config would then fail on all of them.
func TestSaveKeepsTheShapeItRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	writeFile(t, path, `{"repos":{"one/repo":"proj-one","two/repo":["proj-two","proj-three"]}}`)

	g, err := LoadGlobal(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := g.Save(); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var back struct {
		Repos map[string]json.RawMessage `json:"repos"`
	}
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	var one string
	if err := json.Unmarshal(back.Repos["one/repo"], &one); err != nil || one != "proj-one" {
		t.Errorf("one/repo written as %s, want the bare string proj-one", back.Repos["one/repo"])
	}
	var two []string
	if err := json.Unmarshal(back.Repos["two/repo"], &two); err != nil ||
		strings.Join(two, ",") != "proj-two,proj-three" {
		t.Errorf("two/repo written as %s, want a list of both", back.Repos["two/repo"])
	}
}

// ProjectsForRepo hands out a copy, so a caller cannot reach back into the
// loaded config and change what a later lookup answers.
func TestProjectsForRepoDoesNotAliasTheConfig(t *testing.T) {
	g := &Global{Repos: map[string]ProjectIDs{"owner/repo": {"proj-one"}}}

	got := g.ProjectsForRepo("owner/repo")
	got[0] = "mutated"

	if again := g.ProjectsForRepo("owner/repo"); again[0] != "proj-one" {
		t.Errorf("projects = %v; a caller edited the loaded config", again)
	}
}

func TestProjectsForRepoWithNoRepo(t *testing.T) {
	g := &Global{Repos: map[string]ProjectIDs{"owner/repo": {"proj-one"}}}
	if got := g.ProjectsForRepo(""); got != nil {
		t.Errorf("= %v, want nil; there is no repository to look up", got)
	}
}
