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
			w.Write([]byte(`[{"id":"ws1","name":"Wrong"},{"id":"ws2","name":"Indie Dev"}]`))
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
// the server. The id is still known from the task, so it is still recorded.
func TestSessionAttachSurvivesAFailedProjectLookup(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	t.Setenv("KANEO_SESSION_ID", "s1")

	app := newTestApp(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/task/task-2":
			w.Write([]byte(`{"id":"task-2","number":3,"title":"three","projectId":"proj2"}`))
		case "POST /api/comment/task-2":
			w.Write([]byte(`{"id":"c1"}`))
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	})
	if err := run(t, newSessionAttachCommand(app), "task-2", "--strict"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(config, "kaneo", "sessions", "s1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"taskId":"task-2","number":3,"title":"three","projectId":"proj2"}`; string(b) != want {
		t.Errorf("file = %s, want %s", b, want)
	}
}
