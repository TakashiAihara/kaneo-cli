package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNormalizeBaseURL(t *testing.T) {
	tests := map[string]string{
		"https://kaneo.example":         "https://kaneo.example/api",
		"https://kaneo.example/":        "https://kaneo.example/api",
		"https://kaneo.example/api":     "https://kaneo.example/api",
		"https://kaneo.example/api/":    "https://kaneo.example/api",
		"  https://kaneo.example/api  ": "https://kaneo.example/api",
		"https://kaneo.example/sub":     "https://kaneo.example/sub/api",
		"":                              "",
	}
	for in, want := range tests {
		if got := NormalizeBaseURL(in); got != want {
			t.Errorf("NormalizeBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// newServer starts a test server and returns a client pointed at its root, the
// way a user would configure one: the site root, without /api.
func newServer(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return New(srv.URL, "test-key", 0), srv
}

// The site root answers 200 with the web app's HTML for any path, so a request
// that forgets /api looks successful and returns markup. Every call must land
// under /api.
func TestRequestsLandUnderAPIPrefix(t *testing.T) {
	var gotPath string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	})

	if _, err := c.ListWorkspaces(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/auth/organization/list" {
		t.Errorf("path = %q, want /api/auth/organization/list", gotPath)
	}
}

func TestSendsBearerToken(t *testing.T) {
	var gotAuth string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`[]`))
	})

	if _, err := c.ListWorkspaces(context.Background()); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer test-key" {
		t.Errorf("Authorization = %q, want Bearer test-key", gotAuth)
	}
}

func TestListProjectsRequiresWorkspaceQuery(t *testing.T) {
	var gotQuery string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query().Get("workspaceId")
		_, _ = w.Write([]byte(`[{"id":"p1","name":"One","workspaceId":"ws1"}]`))
	})

	got, err := c.ListProjects(context.Background(), "ws1")
	if err != nil {
		t.Fatal(err)
	}
	if gotQuery != "ws1" {
		t.Errorf("workspaceId query = %q, want ws1", gotQuery)
	}
	if len(got) != 1 || got[0].ID != "p1" {
		t.Errorf("projects = %+v", got)
	}
}

const boardBody = `{"data":{"id":"p1","name":"Board","columns":[
  {"id":"to-do","name":"To Do","tasks":[
    {"id":"t2","number":2,"title":"low one","priority":"low","status":"to-do"},
    {"id":"t1","number":1,"title":"urgent one","priority":"urgent","status":"to-do"}]},
  {"id":"done","name":"Done","tasks":[
    {"id":"t3","number":3,"title":"high one","priority":"high","status":"done"}]}]}}`

func TestGetBoardUnnestsColumns(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(boardBody))
	})

	b, err := c.GetBoard(context.Background(), "p1")
	if err != nil {
		t.Fatal(err)
	}
	if b.ProjectName != "Board" {
		t.Errorf("project name = %q, want Board", b.ProjectName)
	}
	if len(b.Columns) != 2 {
		t.Fatalf("columns = %d, want 2", len(b.Columns))
	}

	tasks := b.Tasks()
	if len(tasks) != 3 {
		t.Fatalf("tasks = %d, want 3", len(tasks))
	}
	want := []string{"t1", "t3", "t2"} // urgent, high, low
	for i, id := range want {
		if tasks[i].ID != id {
			t.Errorf("tasks[%d] = %q, want %q (order: %v)", i, tasks[i].ID, id, ids(tasks))
		}
	}
}

func ids(tasks []Task) []string {
	out := make([]string, len(tasks))
	for i, t := range tasks {
		out[i] = t.ID
	}
	return out
}

// The server reports validation failures with HTTP 200 and success:false.
// Treating status alone as the verdict would silently return an empty result.
func TestSuccessFalseOn200IsAnError(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{},"error":[{"message":"Invalid key: Expected \"workspaceId\""}],"success":false}`))
	})

	_, err := c.ListProjects(context.Background(), "")
	if err == nil {
		t.Fatal("expected an error for success:false, got nil")
	}
	apiErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("error type = %T, want *Error", err)
	}
	if len(apiErr.Messages) != 1 || apiErr.Messages[0] == "" {
		t.Errorf("messages = %v, want the server's message", apiErr.Messages)
	}
}

func TestHTTPErrorStatusIsReported(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`Unauthorized`))
	})

	err := c.VerifyKey(context.Background())
	if err == nil {
		t.Fatal("expected an error for 401, got nil")
	}
	apiErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("error type = %T, want *Error", err)
	}
	if apiErr.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", apiErr.StatusCode)
	}
	if !apiErr.Unauthorized() {
		t.Error("Unauthorized() = false, want true")
	}
}

func TestWriteOperationsUseDedicatedEndpoints(t *testing.T) {
	var gotMethod, gotPath, gotBody string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		buf := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(buf)
		gotBody = string(buf)
		w.WriteHeader(http.StatusOK)
	})

	if err := c.SetTaskStatus(context.Background(), "t1", "in-progress"); err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodPut {
		t.Errorf("method = %q, want PUT", gotMethod)
	}
	if gotPath != "/api/task/status/t1" {
		t.Errorf("path = %q, want /api/task/status/t1", gotPath)
	}
	if gotBody != `{"status":"in-progress"}` {
		t.Errorf("body = %q", gotBody)
	}
}
