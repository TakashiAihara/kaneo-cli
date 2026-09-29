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
	if apiErr.StatusCode != 400 || apiErr.Path != "/api/task/move/t1" ||
		len(apiErr.Messages) != 1 || apiErr.Messages[0] != `Invalid key: Expected "destinationProjectId"` {
		t.Errorf("error = %+v", apiErr)
	}
}

func boardPage(page, pages, related, relatedPages int, cols string) string {
	return `{"data":{"id":"p1","name":"Board","slug":"b","workspaceId":"w","columns":[` + cols + `],"archivedTasks":[],"plannedTasks":[]},` +
		`"pagination":{"total":3,"page":` + itoa(page) + `,"pageSize":2,"totalPages":` + itoa(pages) +
		`,"relatedPage":` + itoa(related) + `,"relatedPageSize":100,"relatedTotalPages":` + itoa(relatedPages) + `}}`
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func boardTaskJSON(id string, n int, labels string) string {
	return `{"id":"` + id + `","title":"` + id + `","number":` + itoa(n) + `,"status":"to-do","priority":"low",` +
		`"createdAt":"2026-09-30T00:00:00.000Z","projectId":"p1","subtaskCounts":{"completed":0,"total":0},"labels":[` + labels + `],` +
		`"externalLinks":[{"id":"l","taskId":"` + id + `","resourceType":"issue","externalId":"1","url":"u","metadata":{"state":"open"},"createdAt":"2026-09-30T00:00:00.000Z","updatedAt":"2026-09-30T00:00:00.000Z"}]}`
}

func label(id string) string { return `{"id":"` + id + `","name":"` + id + `","color":"#000"}` }

// columns renders every column of the board, as the server does on every page.
func columns(todo string) string {
	return `{"id":"to-do","slug":"to-do","name":"To Do","isFinal":false,"tasks":[` + todo + `]},` +
		`{"id":"done","slug":"done","name":"Done","isFinal":true,"tasks":[]}`
}

// The board is paged twice over: task pages, and within each, related pages
// that repeat the same tasks with the next labels. Every page of both is read,
// a task repeated on a related page gains its labels, and a task repeated on a
// later task page is kept once.
func TestGetBoardReadsEveryPage(t *testing.T) {
	var queries []string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.RawQuery)
		q := r.URL.Query()
		switch page, related := q.Get("page"), q.Get("relatedPage"); {
		case page == "" && related == "":
			_, _ = w.Write([]byte(boardPage(1, 2, 1, 2, columns(boardTaskJSON("t1", 1, label("a"))+`,`+boardTaskJSON("t2", 2, "")))))
		case page == "" && related == "2":
			// "a" again, as a board changed mid-read would send it.
			_, _ = w.Write([]byte(boardPage(1, 2, 2, 2, columns(boardTaskJSON("t1", 1, label("b")+`,`+label("a"))+`,`+boardTaskJSON("t2", 2, "")))))
		case page == "2" && related == "":
			// t2 again, as a page boundary that moved would repeat it. Its
			// label here must not be added: this is not a related page.
			_, _ = w.Write([]byte(boardPage(2, 2, 1, 1, columns(boardTaskJSON("t2", 2, label("z"))+`,`+boardTaskJSON("t3", 3, "")))))
		default:
			t.Errorf("unexpected query %q", r.URL.RawQuery)
		}
	})

	b, err := c.GetBoard(context.Background(), "p1")
	if err != nil {
		t.Fatal(err)
	}
	// The first request asks for no page: a pre-v2.26.0 server starts paging,
	// unstably, as soon as one is named.
	if strings.Join(queries, "|") != "|relatedPage=2|page=2" {
		t.Errorf("requests = %q", queries)
	}
	if len(b.Columns) != 2 || b.Columns[0].ID != "to-do" || b.Columns[1].ID != "done" {
		t.Fatalf("columns = %+v", b.Columns)
	}
	todo := b.Columns[0].Tasks
	if got := ids(todo); strings.Join(got, ",") != "t1,t2,t3" {
		t.Errorf("to-do tasks = %v", got)
	}
	var names []string
	for _, l := range todo[0].Labels {
		names = append(names, l.Name)
	}
	if strings.Join(names, ",") != "a,b" {
		t.Errorf("t1 labels = %v, want a,b", names)
	}
	if len(todo[1].Labels) != 0 {
		t.Errorf("t2 labels = %+v; a repeat on a later task page added labels", todo[1].Labels)
	}
}

// A server before v2.26.0 answers the plain request with the whole board.
func TestGetBoardMakesOneRequestWhenThereIsOnePage(t *testing.T) {
	calls := 0
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"data":{"id":"p1","name":"Board","columns":[` + columns(boardTaskJSON("t1", 1, "")) + `]},"pagination":{"total":1,"page":1,"pageSize":1,"totalPages":1}}`))
	})
	if _, err := c.GetBoard(context.Background(), "p1"); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Errorf("requests = %d, want 1", calls)
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
	_, ids, ok := strings.Cut(string(cfg), "operation-ids:\n")
	if !ok {
		t.Fatal("gen/cfg.yaml has no operation-ids list")
	}
	listed := regexp.MustCompile(`(?m)^\s+- (\w+)$`).FindAllStringSubmatch(ids, -1)
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

// A 201 or 204 is a success like 200. Reported as a failure, a write that
// happened invites a retry that duplicates it.
func TestAnyTwoHundredIsASuccess(t *testing.T) {
	for _, status := range []int{http.StatusCreated, http.StatusNoContent} {
		c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			if status == http.StatusCreated {
				_, _ = w.Write([]byte(`{"id":"t1","projectId":"p1","title":"x","status":"to-do","priority":"medium","createdAt":"2026-09-30T00:00:00.000Z"}`))
			}
		})
		if status == http.StatusCreated {
			got, err := c.CreateTask(context.Background(), "p1", NewTask{Title: "x"})
			if err != nil {
				t.Errorf("201: %v", err)
			} else if got.ID != "t1" || got.ProjectID != "p1" || got.Title != "x" {
				t.Errorf("201: task = %+v; the body was lost", got)
			}
			continue
		}
		if err := c.DeleteTask(context.Background(), "t1"); err != nil {
			t.Errorf("204: %v", err)
		}
	}
}

// Every call reaches its own route, with the id escaped. The method and the
// whole path are compared, so a wrapper calling a sibling operation fails.
func TestEveryCallHitsItsRouteWithTheIDEscaped(t *testing.T) {
	const id = "a/b"
	ctx := context.Background()
	calls := []struct {
		name, method, path string
		call               func(c *Client) error
	}{
		{"GetProject", "GET", "/api/project/a%2Fb", func(c *Client) error { _, err := c.GetProject(ctx, id); return err }},
		{"Archive", "PUT", "/api/project/a%2Fb/archive", func(c *Client) error { return c.SetProjectArchived(ctx, id, true) }},
		{"Unarchive", "PUT", "/api/project/a%2Fb/unarchive", func(c *Client) error { return c.SetProjectArchived(ctx, id, false) }},
		{"GetBoard", "GET", "/api/task/tasks/a%2Fb", func(c *Client) error { _, err := c.GetBoard(ctx, id); return err }},
		{"GetTask", "GET", "/api/task/a%2Fb", func(c *Client) error { _, err := c.GetTask(ctx, id); return err }},
		{"SetTaskStatus", "PUT", "/api/task/status/a%2Fb", func(c *Client) error { return c.SetTaskStatus(ctx, id, "x") }},
		{"SetTaskPriority", "PUT", "/api/task/priority/a%2Fb", func(c *Client) error { return c.SetTaskPriority(ctx, id, "low") }},
		{"SetTaskAssignee", "PUT", "/api/task/assignee/a%2Fb", func(c *Client) error { return c.SetTaskAssignee(ctx, id, "") }},
		{"MoveTask", "PUT", "/api/task/move/a%2Fb", func(c *Client) error { return c.MoveTask(ctx, id, "p") }},
		{"DeleteTask", "DELETE", "/api/task/a%2Fb", func(c *Client) error { return c.DeleteTask(ctx, id) }},
		{"CreateTask", "POST", "/api/task/a%2Fb", func(c *Client) error { _, err := c.CreateTask(ctx, id, NewTask{}); return err }},
		{"ListComments", "GET", "/api/comment/a%2Fb", func(c *Client) error { _, err := c.ListComments(ctx, id); return err }},
		{"AddComment", "POST", "/api/comment/a%2Fb", func(c *Client) error { _, err := c.AddComment(ctx, id, "x"); return err }},
		{"ListRelations", "GET", "/api/task-relation/a%2Fb", func(c *Client) error { _, err := c.ListRelations(ctx, id); return err }},
		{"UnlinkTasks", "DELETE", "/api/task-relation/a%2Fb", func(c *Client) error { return c.UnlinkTasks(ctx, id) }},
		{"LinkTasks", "POST", "/api/task-relation", func(c *Client) error { _, err := c.LinkTasks(ctx, "s", "d", "blocks"); return err }},
		{"CreateProject", "POST", "/api/project", func(c *Client) error { _, err := c.CreateProject(ctx, NewProject{Name: "n"}); return err }},
		{"ListProjects", "GET", "/api/project", func(c *Client) error { _, err := c.ListProjects(ctx, "w", false); return err }},
		{"ListWorkspaces", "GET", "/api/auth/organization/list", func(c *Client) error { _, err := c.ListWorkspaces(ctx); return err }},
	}
	for _, tc := range calls {
		var method, path string
		c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
			method, path = r.Method, r.URL.EscapedPath()
			w.WriteHeader(http.StatusNoContent)
		})
		// An empty reply is an error for the board, which must name a project,
		// and a success for everything else.
		if err := tc.call(c); (err != nil) != (tc.name == "GetBoard") {
			t.Errorf("%s: err = %v", tc.name, err)
		}
		if method != tc.method || path != tc.path {
			t.Errorf("%s: %s %s, want %s %s", tc.name, method, path, tc.method, tc.path)
		}
	}
}

// What each read maps onto the CLI's types, field by field.
func TestReadsMapEveryField(t *testing.T) {
	ctx := context.Background()

	t.Run("board task", func(t *testing.T) {
		c, _, _ := recorder(t, `{"data":{"id":"p1","name":"B","columns":[{"id":"to-do","name":"To Do","tasks":[`+
			`{"id":"t1","title":"T","number":7,"description":"D","status":"to-do","priority":"high","position":3,"projectId":"p1",`+
			`"assigneeId":"u1","assigneeName":"Ann","startDate":"2026-09-01T00:00:00.000Z","dueDate":"2026-10-01T00:00:00.000Z","createdAt":"2026-09-30T00:00:00.000Z",`+
			`"subtaskCounts":{"completed":0,"total":0},"labels":[{"id":"l1","name":"bug","color":"#f00"}],"externalLinks":[]}]}]},"pagination":{"totalPages":1}}`)
		b, err := c.GetBoard(ctx, "p1")
		if err != nil {
			t.Fatal(err)
		}
		got := b.Columns[0].Tasks[0]
		if got.ID != "t1" || got.Number != 7 || got.Title != "T" || got.Description != "D" || got.Status != "to-do" ||
			got.Priority != "high" || got.Position != 3 || got.ProjectID != "p1" ||
			*got.AssigneeID != "u1" || *got.AssigneeName != "Ann" ||
			*got.StartDate != "2026-09-01T00:00:00.000Z" || *got.DueDate != "2026-10-01T00:00:00.000Z" ||
			got.CreatedAt != "2026-09-30T00:00:00.000Z" || len(got.Labels) != 1 || got.Labels[0] != (Label{ID: "l1", Name: "bug", Color: "#f00"}) {
			t.Errorf("task = %+v", got)
		}
	})

	t.Run("task", func(t *testing.T) {
		c, _, _ := recorder(t, `{"id":"t1","projectId":"p1","number":7,"title":"T","status":"s","priority":"low","createdAt":"2026-09-30T00:00:00.000Z",`+
			`"assigneeId":"u1","assigneeName":"Ann","dueDate":"2026-10-01T00:00:00.000Z"}`)
		got, err := c.GetTask(ctx, "t1")
		if err != nil {
			t.Fatal(err)
		}
		if got.Number != 7 || *got.AssigneeID != "u1" || *got.AssigneeName != "Ann" || *got.DueDate != "2026-10-01T00:00:00.000Z" {
			t.Errorf("task = %+v", got)
		}
	})

	t.Run("relations", func(t *testing.T) {
		c, _, _ := recorder(t, `[{"id":"r1","sourceTaskId":"s","targetTaskId":"d","relationType":"blocks","createdAt":"2026-09-30T00:00:00.000Z"}]`)
		got, err := c.ListRelations(ctx, "s")
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 || got[0] != (Relation{ID: "r1", SourceTaskID: "s", TargetTaskID: "d", RelationType: "blocks"}) {
			t.Errorf("relations = %+v", got)
		}
	})

	t.Run("added comment", func(t *testing.T) {
		c, _, body := recorder(t, `{"id":"c1","taskId":"t1","type":"comment","content":"hi","userId":"u1","createdAt":"2026-09-30T00:00:00.000Z","updatedAt":"2026-09-30T00:00:00.000Z"}`)
		got, err := c.AddComment(ctx, "t1", "hi")
		if err != nil {
			t.Fatal(err)
		}
		if *body != `{"content":"hi"}` || got.ID != "c1" || got.Content != "hi" || got.UserID != "u1" {
			t.Errorf("body = %s, comment = %+v", *body, got)
		}
	})
}

// What each write puts on the wire.
func TestWritesSendEveryField(t *testing.T) {
	ctx := context.Background()

	t.Run("create task", func(t *testing.T) {
		c, _, body := recorder(t, `{"id":"t1","projectId":"p1","title":"x","status":"s","priority":"low","createdAt":"2026-09-30T00:00:00.000Z"}`)
		if _, err := c.CreateTask(ctx, "p1", NewTask{Title: "x", Description: "d", Priority: "high", Status: "review", DueDate: "2026-10-01"}); err != nil {
			t.Fatal(err)
		}
		if *body != `{"title":"x","description":"d","dueDate":"2026-10-01","priority":"high","status":"review"}` {
			t.Errorf("body = %s", *body)
		}
	})

	t.Run("create task defaults", func(t *testing.T) {
		c, _, body := recorder(t, `{"id":"t1","projectId":"p1","title":"x","status":"s","priority":"low","createdAt":"2026-09-30T00:00:00.000Z"}`)
		if _, err := c.CreateTask(ctx, "p1", NewTask{Title: "x"}); err != nil {
			t.Fatal(err)
		}
		if *body != `{"title":"x","description":"","priority":"medium","status":"to-do"}` {
			t.Errorf("body = %s", *body)
		}
	})

	t.Run("list projects", func(t *testing.T) {
		for archived, want := range map[bool]string{false: "workspaceId=w", true: "includeArchived=true&workspaceId=w"} {
			c, req, _ := recorder(t, `[]`)
			if _, err := c.ListProjects(ctx, "w", archived); err != nil {
				t.Fatal(err)
			}
			if req.URL.RawQuery != want {
				t.Errorf("archived=%v: query = %q, want %q", archived, req.URL.RawQuery, want)
			}
		}
	})

	t.Run("link", func(t *testing.T) {
		c, _, body := recorder(t, `{"id":"r1","sourceTaskId":"s","targetTaskId":"d","relationType":"subtask","createdAt":"2026-09-30T00:00:00.000Z"}`)
		got, err := c.LinkTasks(ctx, "s", "d", "subtask")
		if err != nil {
			t.Fatal(err)
		}
		if *body != `{"sourceTaskId":"s","targetTaskId":"d","relationType":"subtask"}` || got.SourceTaskID != "s" || got.TargetTaskID != "d" {
			t.Errorf("body = %s, relation = %+v", *body, got)
		}
	})
}

// A write's reply is mapped in full, and a number past float32's exact range
// comes through unchanged.
func TestWriteReplyMapsEveryField(t *testing.T) {
	c, _, _ := recorder(t, `{"id":"t1","projectId":"p1","number":16777217,"position":16777219,"title":"x","description":"d","status":"s","priority":"low",`+
		`"userId":"u1","startDate":"2026-09-01T00:00:00.000Z","dueDate":"2026-10-01T00:00:00.000Z","createdAt":"2026-09-30T00:00:00.123Z"}`)
	got, err := c.CreateTask(context.Background(), "p1", NewTask{Title: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "t1" || got.ProjectID != "p1" || got.Number != 16777217 || got.Position != 16777219 || got.Title != "x" ||
		got.Description != "d" || got.Status != "s" || got.Priority != "low" || *got.AssigneeID != "u1" ||
		*got.StartDate != "2026-09-01T00:00:00.000Z" || *got.DueDate != "2026-10-01T00:00:00.000Z" || got.CreatedAt != "2026-09-30T00:00:00.123Z" {
		t.Errorf("task = %+v", got)
	}
}

// UpdateProject reads and writes the same escaped route.
func TestUpdateProjectEscapesTheID(t *testing.T) {
	var paths []string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.EscapedPath())
		_, _ = w.Write([]byte(`{"id":"a/b","name":"New","slug":"s","icon":"Box","description":"d","createdAt":"2026-09-30T00:00:00.000Z","position":1,"lastTaskNumber":0}`))
	})
	name := "New"
	if _, _, err := c.UpdateProject(context.Background(), "a/b", ProjectChanges{Name: &name}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(paths, ", ") != "GET /api/project/a%2Fb, PUT /api/project/a%2Fb" {
		t.Errorf("requests = %v", paths)
	}
}
