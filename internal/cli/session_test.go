package cli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// The project must come from the task. The cwd resolves to proj1 here while
// the task lives on proj2; taking the cwd's project would name the wrong
// board with nothing to show it is wrong.
func TestSessionAttachRecordsTheTasksProjectNotTheCwds(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("KANEO_SESSION_ID", "s1")

	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/task/task-2":
			w.Write([]byte(`{"id":"task-2","number":3,"title":"three","projectId":"proj2"}`))
		case "GET /api/project/proj2":
			w.Write([]byte(`{"id":"proj2","name":"Other Board","workspaceId":"ws2"}`))
		case "GET /api/auth/organization/list":
			w.Write([]byte(`[{"id":"ws2","name":"Indie Dev"},{"id":"ws2","name":"Duplicate"},{"id":"ws1","name":"Wrong"}]`))
		case "POST /api/comment/task-2":
			w.Write([]byte(`{"id":"c1"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(filepath.Join(config, "kaneo", "sessions", "s1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"taskId": "task-2", "number": float64(3), "title": "three",
		"projectId": "proj2", "projectName": "Other Board",
		"workspaceId": "ws2", "workspaceName": "Indie Dev",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v (file: %s)", k, got[k], v, b)
		}
	}
}

// A failed name lookup must not fail the attach: the marker is already on
// the server. The project lookup succeeds and the workspace one fails, so the
// test sees both were attempted and only the failed one's field is left out.
func TestSessionAttachSurvivesAFailedWorkspaceLookup(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("KANEO_SESSION_ID", "s1")

	seen := map[string]bool{}
	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		key := r.Method + " " + r.URL.Path
		seen[key] = true
		switch key {
		case "GET /api/task/task-2":
			w.Write([]byte(`{"id":"task-2","number":3,"title":"three","projectId":"proj2"}`))
		case "GET /api/project/proj2":
			w.Write([]byte(`{"id":"proj2","name":"Other Board","workspaceId":"ws2"}`))
		case "GET /api/auth/organization/list":
			w.WriteHeader(http.StatusInternalServerError)
		case "POST /api/comment/task-2":
			w.Write([]byte(`{"id":"c1"}`))
		default:
			t.Errorf("unexpected %s", key)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"GET /api/auth/organization/list", "POST /api/comment/task-2"} {
		if !seen[k] {
			t.Errorf("%s was not requested", k)
		}
	}
	b, err := os.ReadFile(filepath.Join(config, "kaneo", "sessions", "s1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"taskId":"task-2","number":3,"title":"three","projectId":"proj2","projectName":"Other Board","workspaceId":"ws2"}`; string(b) != want {
		t.Errorf("file = %s, want %s", b, want)
	}
}

// A task named by number comes off the board listing, whose tasks may carry
// no projectId. It is on that board by definition, so that board is recorded.
func TestSessionAttachByNumberRecordsTheBoardsProject(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("KANEO_SESSION_ID", "s1")

	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/task/tasks/proj1":
			w.Write([]byte(testBoard))
		case "GET /api/project/proj1":
			w.Write([]byte(`{"id":"proj1","name":"Board","workspaceId":"ws1"}`))
		case "GET /api/auth/organization/list":
			w.Write([]byte(`[{"id":"ws1","name":"W"}]`))
		case "POST /api/comment/real-task-id":
			w.Write([]byte(`{"id":"c1"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	if err := run(t, newSessionAttachCommand(app), "7", "--strict"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(config, "kaneo", "sessions", "s1.json"))
	want := `{"taskId":"real-task-id","number":7,"title":"seven","projectId":"proj1","projectName":"Board","workspaceId":"ws1","workspaceName":"W"}`
	if string(b) != want {
		t.Errorf("file = %s, want %s", b, want)
	}
}

// A task fetched by id that does not say its project must not be given the
// cwd's: an unknown board stays unrecorded rather than wrong.
func TestSessionAttachNeverFallsBackToTheCwdsProject(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("KANEO_SESSION_ID", "s1")

	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/task/task-2":
			w.Write([]byte(`{"id":"task-2","number":3,"title":"three"}`))
		case "POST /api/comment/task-2":
			w.Write([]byte(`{"id":"c1"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(config, "kaneo", "sessions", "s1.json"))
	if want := `{"taskId":"task-2","number":3,"title":"three"}`; string(b) != want {
		t.Errorf("file = %s, want %s", b, want)
	}
}
