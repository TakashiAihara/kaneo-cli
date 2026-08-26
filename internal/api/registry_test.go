package api

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestExpandFillsPlaceholdersInOrder(t *testing.T) {
	op := Operation{Path: "/task/status/{id}"}
	if got := op.Expand("abc"); got != "/task/status/abc" {
		t.Errorf("Expand = %q", got)
	}

	noParams := Operation{Path: "/project"}
	if got := noParams.Expand(); got != "/project" {
		t.Errorf("Expand = %q, want /project", got)
	}
}

func TestExpandEscapesValues(t *testing.T) {
	op := Operation{Path: "/task/{id}"}
	got := op.Expand("a/b?c")
	if strings.Contains(got, "?") || strings.Count(got, "/") != 2 {
		t.Errorf("Expand = %q; a value escaped into the path structure", got)
	}
}

// Every operation must be declared before it can be used, so the registry has
// to be internally consistent: no duplicate ids, and every field populated.
func TestRegistryIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, op := range Operations {
		if op.ID == "" || op.Method == "" || op.Path == "" || op.Command == "" {
			t.Errorf("incomplete entry: %+v", op)
		}
		if seen[op.ID] {
			t.Errorf("duplicate operation id %q", op.ID)
		}
		seen[op.ID] = true
		if !strings.HasPrefix(op.Path, "/") {
			t.Errorf("path %q does not start with /", op.Path)
		}
	}
}

func TestCompareClassifiesOperations(t *testing.T) {
	client := []Operation{
		{ID: "here", Method: "GET", Path: "/a", Command: "kaneo a"},
		{ID: "gone", Method: "GET", Path: "/b", Command: "kaneo b"},
	}
	got := compare(client, []string{"here", "extra"})

	if len(got.Covered) != 1 || got.Covered[0].ID != "here" {
		t.Errorf("covered = %+v", got.Covered)
	}
	if len(got.Missing) != 1 || got.Missing[0].ID != "gone" {
		t.Errorf("missing = %+v", got.Missing)
	}
	if len(got.NewOnServer) != 1 || got.NewOnServer[0] != "extra" {
		t.Errorf("newOnServer = %+v", got.NewOnServer)
	}
	if got.OK() {
		t.Error("OK() = true while an operation this client calls is missing")
	}
}

func TestCompareIsOKWhenNothingIsMissing(t *testing.T) {
	client := []Operation{{ID: "here", Method: "GET", Path: "/a", Command: "kaneo a"}}
	got := compare(client, []string{"here", "extra"})
	if !got.OK() {
		t.Error("OK() = false although every client operation is present")
	}
	if len(got.NewOnServer) != 1 {
		t.Errorf("an unused server operation must not make the check fail: %+v", got)
	}
}

// The OpenAPI document is fetched through the normal client so that it lands
// under /api. The site root answers 200 with HTML for any path.
func TestFetchOperationIDsUsesTheAPIPrefix(t *testing.T) {
	var gotPath string
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"paths":{"/project":{"get":{"operationId":"listProjects"}}}}`))
	})

	ids, err := c.FetchOperationIDs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/openapi" {
		t.Errorf("path = %q, want /api/openapi", gotPath)
	}
	if len(ids) != 1 || ids[0] != "listProjects" {
		t.Errorf("ids = %v", ids)
	}
}
