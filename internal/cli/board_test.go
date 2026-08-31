package cli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TakashiAihara/kaneo-cli/internal/config"
	"github.com/TakashiAihara/kaneo-cli/internal/output"
)

// boardServer answers the board endpoint for the named projects and returns
// nothing at all for any other. Comments are always empty, so a board's
// content is decided by this table alone.
func boardServer(t *testing.T, names map[string]string, broken map[string]bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/comment/") {
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/api/task/tasks/")
		if broken[id] {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		name, ok := names[id]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fmt.Fprintf(w, `{"data":{"id":%q,"name":%q,"columns":[{"id":"to-do","name":"To Do","tasks":[
		  {"id":"%s-task","number":1,"title":"task in %s","priority":"high","status":"to-do"}]}]}}`,
			id, name, id, name)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// appFor builds an App over srv with the given projects already resolved, and
// hands back the buffers so a test can read what was written.
func appFor(srv *httptest.Server, jsonMode bool, projects ...string) (*App, *strings.Builder, *strings.Builder) {
	out, errOut := &strings.Builder{}, &strings.Builder{}
	return &App{
		Cfg: config.Resolved{
			APIURL: srv.URL, APIKey: "k", ProjectIDs: projects,
			Repo: "owner/repo", Origin: map[string]config.Source{},
		},
		Out:     &output.Writer{Mode: output.Mode{JSON: jsonMode}, Out: out, Err: errOut},
		Timeout: 5 * time.Second,
	}, out, errOut
}

// The whole point of the repo map taking a list: a repository tied to several
// projects shows all of their boards, each under its own heading.
func TestBoardCoversEveryMappedProject(t *testing.T) {
	srv := boardServer(t, map[string]string{"proj-one": "One", "proj-two": "Two"}, nil)
	app, out, _ := appFor(srv, false, "proj-one", "proj-two")

	if err := run(t, newBoardCommand(app), "--strict"); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	for _, want := range []string{"## One (open 1 / done 0)", "## Two (open 1 / done 0)",
		"task in One", "task in Two"} {
		if !strings.Contains(text, want) {
			t.Errorf("board is missing %q:\n%s", want, text)
		}
	}
}

func TestBoardJSONCarriesEveryProject(t *testing.T) {
	srv := boardServer(t, map[string]string{"proj-one": "One", "proj-two": "Two"}, nil)
	app, out, _ := appFor(srv, true, "proj-one", "proj-two")

	if err := run(t, newBoardCommand(app), "--strict"); err != nil {
		t.Fatal(err)
	}
	var reports []boardReport
	if err := json.Unmarshal([]byte(out.String()), &reports); err != nil {
		t.Fatalf("board JSON is not a list of reports: %v\n%s", err, out.String())
	}
	if len(reports) != 2 || reports[0].Project != "One" || reports[1].Project != "Two" {
		t.Errorf("reports = %+v, want One then Two", reports)
	}
}

// A single project must still be a list of one rather than a bare object, so
// that a reader does not have to tell the two shapes apart.
func TestBoardJSONIsAListEvenForOneProject(t *testing.T) {
	srv := boardServer(t, map[string]string{"proj-one": "One"}, nil)
	app, out, _ := appFor(srv, true, "proj-one")

	if err := run(t, newBoardCommand(app), "--strict"); err != nil {
		t.Fatal(err)
	}
	var reports []boardReport
	if err := json.Unmarshal([]byte(out.String()), &reports); err != nil {
		t.Fatalf("board JSON is not a list: %v\n%s", err, out.String())
	}
	if len(reports) != 1 {
		t.Errorf("reports = %+v, want exactly one", reports)
	}
}

// board runs from a session-start hook. A repository nobody mapped has always
// produced nothing at all, and that is what tells the hook to stay quiet.
func TestBoardOnAnUnmappedRepoPrintsNothingAndSucceeds(t *testing.T) {
	srv := boardServer(t, map[string]string{"proj-one": "One"}, nil)
	app, out, errOut := appFor(srv, false)

	if err := run(t, newBoardCommand(app)); err != nil {
		t.Fatalf("err = %v, want nil; an unmapped repo is the ordinary case", err)
	}
	if out.String() != "" || errOut.String() != "" {
		t.Errorf("wrote %q / %q, want nothing at all", out.String(), errOut.String())
	}
}

// One project that cannot be read should not cost the others their board, for
// the same reason a task whose comments cannot be read is skipped.
func TestBoardKeepsTheProjectsItCouldRead(t *testing.T) {
	srv := boardServer(t, map[string]string{"proj-two": "Two"}, map[string]bool{"proj-one": true})
	app, out, _ := appFor(srv, false, "proj-one", "proj-two")

	if err := run(t, newBoardCommand(app), "--strict"); err != nil {
		t.Fatalf("err = %v; a partial board is better than none", err)
	}
	if !strings.Contains(out.String(), "## Two") {
		t.Errorf("the readable project is missing:\n%s", out.String())
	}
}

// When nothing could be read there is no partial board to keep, so the failure
// is real and --strict has to show it.
func TestBoardReportsWhenNoProjectCouldBeRead(t *testing.T) {
	srv := boardServer(t, nil, map[string]bool{"proj-one": true, "proj-two": true})
	app, _, _ := appFor(srv, false, "proj-one", "proj-two")

	if err := run(t, newBoardCommand(app), "--strict"); err == nil {
		t.Error("every project failed and board still reported success")
	}
}

// Fail-open is unchanged: without --strict the same total failure is silent.
func TestBoardStaysSilentWhenEveryProjectFails(t *testing.T) {
	srv := boardServer(t, nil, map[string]bool{"proj-one": true})
	app, out, errOut := appFor(srv, false, "proj-one")

	if err := run(t, newBoardCommand(app)); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if out.String() != "" || errOut.String() != "" {
		t.Errorf("wrote %q / %q, want nothing", out.String(), errOut.String())
	}
}

// A command that writes has to name one board. Taking the first of several
// would send the write to a project nobody chose, and the repo map states no
// order of precedence to read a default out of.
func TestSingleProjectCommandsRefuseAnAmbiguousRepo(t *testing.T) {
	app := &App{Cfg: config.Resolved{
		ProjectIDs: []string{"proj-one", "proj-two"}, Repo: "owner/repo",
		Origin: map[string]config.Source{},
	}}

	_, err := app.Project()
	if err == nil {
		t.Fatal("Project() picked one of several mapped projects")
	}
	for _, want := range []string{"owner/repo", "proj-one", "proj-two", "--project"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestProjectReturnsTheSoleMappedProject(t *testing.T) {
	app := &App{Cfg: config.Resolved{ProjectIDs: []string{"proj-one"}}}
	got, err := app.Project()
	if err != nil || got != "proj-one" {
		t.Errorf("= %q, %v; want proj-one", got, err)
	}
}

func TestProjectReportsWhenNothingIsConfigured(t *testing.T) {
	app := &App{Cfg: config.Resolved{}}
	if _, err := app.Project(); err == nil {
		t.Error("Project() answered with no project configured")
	}
	if _, err := app.Projects(); err == nil {
		t.Error("Projects() answered with no project configured")
	}
}

// Narrowing has to reach the command, not just the resolver: with --project
// the board shows that one project alone.
func TestBoardHonoursAChosenProject(t *testing.T) {
	srv := boardServer(t, map[string]string{"proj-one": "One", "proj-two": "Two"}, nil)
	app, out, _ := appFor(srv, false, "proj-two")

	if err := run(t, newBoardCommand(app), "--strict"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "## One") {
		t.Errorf("board showed a project that was not chosen:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "## Two") {
		t.Errorf("board is missing the chosen project:\n%s", out.String())
	}
}
