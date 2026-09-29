package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// recorder captures the one request a call makes and answers with reply.
func recorder(t *testing.T, reply string) (*Client, *http.Request, *string) {
	t.Helper()
	var got http.Request
	var body string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		got = *r
		buf, _ := io.ReadAll(r.Body)
		body = string(buf)
		_, _ = w.Write([]byte(reply))
	})
	return c, &got, &body
}

// The server's move route reads destinationProjectId. Sending anything else is
// a 400, which is how the hand-written client failed before.
func TestMoveTaskSendsTheDestinationProject(t *testing.T) {
	c, req, body := recorder(t, `{}`)
	if err := c.MoveTask(context.Background(), "t1", "p2"); err != nil {
		t.Fatal(err)
	}
	if req.Method != http.MethodPut || req.URL.Path != "/api/task/move/t1" {
		t.Errorf("request = %s %s", req.Method, req.URL.Path)
	}
	if *body != `{"destinationProjectId":"p2"}` {
		t.Errorf("body = %s", *body)
	}
}

// userId is required: null unassigns, so it must be sent, not left out.
func TestSetTaskAssigneeSendsNullToUnassign(t *testing.T) {
	for userID, want := range map[string]string{"": `{"userId":null}`, "u1": `{"userId":"u1"}`} {
		c, _, body := recorder(t, `{}`)
		if err := c.SetTaskAssignee(context.Background(), "t1", userID); err != nil {
			t.Fatal(err)
		}
		if *body != want {
			t.Errorf("userID %q: body = %s, want %s", userID, *body, want)
		}
	}
}

// The create route takes the assignee as userId; an assigneeId key is ignored.
func TestCreateTaskSendsTheAssigneeAsUserID(t *testing.T) {
	c, _, body := recorder(t, `{"id":"t1","projectId":"p1","title":"x","status":"to-do","priority":"medium","createdAt":"2026-09-30T00:00:00.000Z","userId":"u1"}`)
	got, err := c.CreateTask(context.Background(), "p1", NewTask{Title: "x", AssigneeID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	var sent map[string]any
	if err := json.Unmarshal([]byte(*body), &sent); err != nil {
		t.Fatal(err)
	}
	if sent["userId"] != "u1" {
		t.Errorf("body = %s", *body)
	}
	if _, ok := sent["assigneeId"]; ok {
		t.Errorf("body still carries assigneeId: %s", *body)
	}
	if got.AssigneeID == nil || *got.AssigneeID != "u1" {
		t.Errorf("assignee = %v", got.AssigneeID)
	}
}

// The generated client puts path values in as they are, so an id holding a
// separator must be escaped before it gets there.
func TestPathValuesAreEscaped(t *testing.T) {
	c, req, _ := recorder(t, `{"id":"x","projectId":"p","title":"t","status":"s","priority":"low","createdAt":"2026-09-30T00:00:00.000Z"}`)
	if _, err := c.GetTask(context.Background(), "a/b?c"); err != nil {
		t.Fatal(err)
	}
	if got := req.URL.EscapedPath(); got != "/api/task/a%2Fb%3Fc" {
		t.Errorf("path = %s; a value escaped into the path structure", got)
	}
	if req.URL.RawQuery != "" {
		t.Errorf("query = %q", req.URL.RawQuery)
	}
}

// Failures keep the server's message and name the full path, so the path in an
// error can be tried with curl as it is.
func TestGeneratedCallFailuresKeepTheServerMessage(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"success":false,"error":{"message":"Invalid key: Expected \"destinationProjectId\""}}`))
	})
	err := c.MoveTask(context.Background(), "t1", "p2")
	apiErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("error = %T %v, want *Error", err, err)
	}
	if apiErr.StatusCode != 400 || apiErr.Path != "/api/task/move/t1" || len(apiErr.Messages) != 1 {
		t.Errorf("error = %+v", apiErr)
	}
}

func boardPage(page, pages int, related int, cols string) string {
	return `{"data":{"id":"p1","name":"Board","slug":"b","workspaceId":"w","columns":[` + cols + `],"archivedTasks":[],"plannedTasks":[]},` +
		`"pagination":{"total":3,"page":` + itoa(page) + `,"pageSize":2,"totalPages":` + itoa(pages) +
		`,"relatedPage":1,"relatedPageSize":100,"relatedTotalPages":` + itoa(related) + `}}`
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func boardTaskJSON(id string, n int, status string) string {
	return `{"id":"` + id + `","title":"` + id + `","number":` + itoa(n) + `,"status":"` + status +
		`","priority":"low","createdAt":"2026-09-30T00:00:00.000Z","projectId":"p1","subtaskCounts":{"completed":0,"total":0},"labels":[],` +
		`"externalLinks":[{"id":"l","taskId":"` + id + `","resourceType":"issue","externalId":"1","url":"u","metadata":{"state":"open"},"createdAt":"2026-09-30T00:00:00.000Z","updatedAt":"2026-09-30T00:00:00.000Z"}]}`
}

// The board is paginated. Every page is read, and columns that recur across
// pages are merged rather than repeated.
func TestGetBoardReadsEveryPage(t *testing.T) {
	var queries []string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.RawQuery)
		switch r.URL.Query().Get("page") {
		case "1":
			_, _ = w.Write([]byte(boardPage(1, 2, 1,
				`{"id":"to-do","slug":"to-do","name":"To Do","isFinal":false,"tasks":[`+boardTaskJSON("t1", 1, "to-do")+`,`+boardTaskJSON("t2", 2, "to-do")+`]}`)))
		case "2":
			_, _ = w.Write([]byte(boardPage(2, 2, 1,
				`{"id":"to-do","slug":"to-do","name":"To Do","isFinal":false,"tasks":[`+boardTaskJSON("t3", 3, "to-do")+`]},`+
					`{"id":"done","slug":"done","name":"Done","isFinal":true,"tasks":[]}`)))
		default:
			t.Errorf("unexpected query %q", r.URL.RawQuery)
		}
	})

	b, err := c.GetBoard(context.Background(), "p1")
	if err != nil {
		t.Fatal(err)
	}
	if len(queries) != 2 {
		t.Fatalf("requests = %v, want 2", queries)
	}
	for _, q := range queries {
		if !strings.Contains(q, "limit=100") {
			t.Errorf("query %q does not ask for the largest page", q)
		}
	}
	if len(b.Columns) != 2 || b.Columns[0].ID != "to-do" || b.Columns[1].ID != "done" {
		t.Fatalf("columns = %+v", b.Columns)
	}
	if got := ids(b.Columns[0].Tasks); strings.Join(got, ",") != "t1,t2,t3" {
		t.Errorf("to-do tasks = %v", got)
	}
}

// Labels past the first related page would be missing without a word, so such
// a board is refused.
func TestGetBoardRefusesABoardWithMoreRelatedPages(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(boardPage(1, 1, 2, `{"id":"to-do","slug":"to-do","name":"To Do","isFinal":false,"tasks":[]}`)))
	})
	if _, err := c.GetBoard(context.Background(), "p1"); err == nil {
		t.Error("a board with a second related page was returned as complete")
	}
}

// archivedAt is a timestamp string, and it is printed back as the server sent
// it.
func TestListProjectsReadsArchivedAt(t *testing.T) {
	c, _, _ := recorder(t, `[{"id":"p1","workspaceId":"w","slug":"s","name":"n","createdAt":"2026-09-07T00:47:08.628Z","archivedAt":"2026-09-07T00:47:08.620Z","position":1,"lastTaskNumber":0,"statistics":{"completionPercentage":0,"totalTasks":0},"archivedTasks":[],"plannedTasks":[],"columns":[]}]`)
	got, err := c.ListProjects(context.Background(), "w", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ArchivedAt == nil || *got[0].ArchivedAt != "2026-09-07T00:47:08.620Z" {
		t.Errorf("projects = %+v", got)
	}
}

// The author's name arrives nested under user.
func TestListCommentsReadsTheAuthorName(t *testing.T) {
	c, _, _ := recorder(t, `[{"id":"c1","taskId":"t1","userId":"u1","content":"hi","createdAt":"2026-09-30T00:00:00.000Z","updatedAt":"2026-09-30T00:00:00.000Z","user":{"name":"Claude","image":null}}]`)
	got, err := c.ListComments(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].UserName != "Claude" || got[0].CreatedAt != "2026-09-30T00:00:00.000Z" {
		t.Errorf("comments = %+v", got)
	}
}

// The registry, the generator's filter and the pinned OpenAPI document have to
// name the same operations the same way; otherwise api-check would vouch for a
// request the client does not make.
func TestRegistryMatchesTheGeneratedClient(t *testing.T) {
	cfg, err := os.ReadFile("gen/cfg.yaml")
	if err != nil {
		t.Fatal(err)
	}
	listed := regexp.MustCompile(`(?m)^\s+- ([A-Za-z]+)$`).FindAllStringSubmatch(string(cfg), -1)
	var fromCfg, fromRegistry []string
	for _, m := range listed {
		fromCfg = append(fromCfg, m[1])
	}
	for _, op := range Operations {
		fromRegistry = append(fromRegistry, op.ID)
	}
	sort.Strings(fromCfg)
	sort.Strings(fromRegistry)
	if strings.Join(fromCfg, ",") != strings.Join(fromRegistry, ",") {
		t.Errorf("gen/cfg.yaml operation-ids = %v\nregistry = %v", fromCfg, fromRegistry)
	}

	raw, err := os.ReadFile("gen/openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Paths map[string]map[string]struct {
			OperationID string `json:"operationId"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, op := range Operations {
		got, ok := doc.Paths[op.Path][strings.ToLower(op.Method)]
		if !ok || got.OperationID != op.ID {
			t.Errorf("%s: %s %s is %q in gen/openapi.json", op.ID, op.Method, op.Path, got.OperationID)
		}
	}
}
