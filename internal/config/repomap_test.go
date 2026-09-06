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

// A flag names one project, so whatever the repo map holds, the answer is that
// one. It wins by precedence rather than by picking out of the list, so it is
// the answer whether or not it names one of the mapped projects — and either
// way it is how a single project gets acted on in a repository mapped to
// several.
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
		// Naming one of the mapped projects is the ordinary case: this is how
		// a repository mapped to several gets acted on one at a time.
		{"flag names a mapped project", Inputs{Dir: home, Home: home, Global: g, Repo: "owner/repo",
			Flags: Flags{ProjectID: "proj-two"}}, SourceFlag},
	} {
		want := "proj-chosen"
		if tc.name == "flag names a mapped project" {
			want = "proj-two"
		}
		r := Resolve(tc.in)
		if got := strings.Join(r.ProjectIDs, ","); got != want {
			t.Errorf("%s: projects = %q, want just %s", tc.name, got, want)
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

// Save rewrites the whole file, and an older build parses every value as a
// string and fails the whole file on the first one it cannot. So an entry is
// widened to a list only when it genuinely holds more than one id — including
// the singleton list and the empty value, which come back as strings even
// though that is not the shape they were written in.
func TestSaveWidensOnlyGenuineLists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	writeFile(t, path, `{"repos":{"one/repo":"proj-one","two/repo":["proj-two","proj-three"],`+
		`"lone/repo":["proj-lone"],"blank/repo":"","empty/repo":[]}}`)

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

	// A singleton list is not written back as a list: it holds one id, and an
	// older build can read a string.
	var lone string
	if err := json.Unmarshal(back.Repos["lone/repo"], &lone); err != nil || lone != "proj-lone" {
		t.Errorf("lone/repo written as %s, want the bare string proj-lone", back.Repos["lone/repo"])
	}

	// The empty value is the one that bites: "" was readable by a build that
	// predates this, [] is not, so a config that was fine before Save ran must
	// not come back broken.
	for _, key := range []string{"blank/repo", "empty/repo"} {
		var blank string
		if err := json.Unmarshal(back.Repos[key], &blank); err != nil || blank != "" {
			t.Errorf("%s written as %s, want an empty string an older build can read",
				key, back.Repos[key])
		}
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
