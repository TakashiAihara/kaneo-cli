package api

// Operation is one server operation this client calls.
//
// Requests are built by the generated client (package gen), which is
// generated for exactly the operation ids listed here: gen/cfg.yaml names the
// same ids, and TestRegistryMatchesTheGeneratedClient fails when the two
// drift. api-check compares these entries against a live server's document.
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

// Operations is everything this client calls.
var Operations = []Operation{
	{ID: "listOrganization", Method: "GET", Path: "/auth/organization/list", Command: "kaneo whoami / workspace ls"},
	{ID: "updateOrganization", Method: "POST", Path: "/auth/organization/update", Command: "kaneo workspace rename"},

	{ID: "listProjects", Method: "GET", Path: "/project", Command: "kaneo project ls"},
	{ID: "getProject", Method: "GET", Path: "/project/{id}", Command: "kaneo project get"},
	{ID: "createProject", Method: "POST", Path: "/project", Command: "kaneo project create"},
	{ID: "updateProject", Method: "PUT", Path: "/project/{id}", Command: "kaneo project update"},
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
