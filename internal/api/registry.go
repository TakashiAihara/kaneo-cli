package api

import (
	"net/url"
	"strings"
)

// Operation is one server operation this client knows how to call.
//
// The registry is the single source of truth: every request is built from an
// entry here, and api-check compares the same entries against the server's
// OpenAPI document. An operation cannot therefore be used without being
// declared, which is what keeps the check honest.
type Operation struct {
	// ID is the server's operationId, the key api-check matches on.
	ID string
	// Method is the HTTP verb.
	Method string
	// Path is the template, with {placeholders} as the server documents them.
	Path string
	// Command names the CLI surface that needs it, so a missing operation
	// says what will stop working.
	Command string
}

// Expand fills the template's placeholders in order and escapes each value.
func (o Operation) Expand(args ...string) string {
	out := o.Path
	for _, arg := range args {
		open := strings.Index(out, "{")
		if open < 0 {
			break
		}
		close := strings.Index(out[open:], "}")
		if close < 0 {
			break
		}
		out = out[:open] + url.PathEscape(arg) + out[open+close+1:]
	}
	return out
}

// Operations is everything this client calls.
var Operations = []Operation{
	{ID: "listOrganization", Method: "GET", Path: "/auth/organization/list", Command: "kaneo whoami / workspace ls"},

	{ID: "listProjects", Method: "GET", Path: "/project", Command: "kaneo project ls"},
	{ID: "getProject", Method: "GET", Path: "/project/{id}", Command: "kaneo project get"},
	{ID: "createProject", Method: "POST", Path: "/project", Command: "kaneo project create"},
	{ID: "archiveProject", Method: "PUT", Path: "/project/{id}/archive", Command: "kaneo project archive"},
	{ID: "unarchiveProject", Method: "PUT", Path: "/project/{id}/unarchive", Command: "kaneo project unarchive"},

	{ID: "listTasks", Method: "GET", Path: "/task/tasks/{projectId}", Command: "kaneo task ls / board"},
	{ID: "getTask", Method: "GET", Path: "/task/{id}", Command: "kaneo task get"},
	{ID: "createTask", Method: "POST", Path: "/task/{projectId}", Command: "kaneo task create"},
	{ID: "deleteTask", Method: "DELETE", Path: "/task/{id}", Command: "kaneo task rm"},
	{ID: "updateTaskStatus", Method: "PUT", Path: "/task/status/{id}", Command: "kaneo task status"},
	{ID: "updateTaskPriority", Method: "PUT", Path: "/task/priority/{id}", Command: "kaneo task priority"},
	{ID: "updateTaskAssignee", Method: "PUT", Path: "/task/assignee/{id}", Command: "kaneo task assign"},
	{ID: "moveTask", Method: "PUT", Path: "/task/move/{id}", Command: "kaneo task move"},

	{ID: "createTaskRelation", Method: "POST", Path: "/task-relation", Command: "kaneo task link"},
	{ID: "getTaskRelations", Method: "GET", Path: "/task-relation/{taskId}", Command: "kaneo task links"},
	{ID: "deleteTaskRelation", Method: "DELETE", Path: "/task-relation/{id}", Command: "kaneo task unlink"},

	{ID: "getTaskComments", Method: "GET", Path: "/comment/{taskId}", Command: "kaneo comment ls / board"},
	{ID: "createTaskComment", Method: "POST", Path: "/comment/{taskId}", Command: "kaneo comment add / session"},
}

// operation looks an entry up by id. It panics on an unknown id because the
// argument is always a literal in this package: a miss is a build-time
// mistake, not a runtime condition.
func operation(id string) Operation {
	for _, op := range Operations {
		if op.ID == id {
			return op
		}
	}
	panic("api: undeclared operation " + id)
}
