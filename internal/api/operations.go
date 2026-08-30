package api

import (
	"context"
	"net/url"
	"sort"
)

// ListWorkspaces returns the workspaces the key can see.
//
// This is also the only cheap call that can tell a valid key from an invalid
// one. /auth/get-session answers 200 with null for a valid key, an invalid key
// and no key at all, so it has no discriminating power and must not be used to
// check credentials.
func (c *Client) ListWorkspaces(ctx context.Context) ([]Workspace, error) {
	op := operation("listOrganization")
	var out []Workspace
	if err := c.Do(ctx, op.Method, op.Expand(), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// VerifyKey reports whether the configured key is accepted.
func (c *Client) VerifyKey(ctx context.Context) error {
	_, err := c.ListWorkspaces(ctx)
	return err
}

// ListProjects returns the projects in a workspace. workspaceId is a required
// query parameter; omitting it is a 400, not an unfiltered listing.
func (c *Client) ListProjects(ctx context.Context, workspaceID string) ([]Project, error) {
	op := operation("listProjects")
	var out []Project
	q := url.Values{"workspaceId": {workspaceID}}
	if err := c.Do(ctx, op.Method, op.Expand(), q, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetProject fetches one project by id.
func (c *Client) GetProject(ctx context.Context, projectID string) (*Project, error) {
	op := operation("getProject")
	var out Project
	if err := c.Do(ctx, op.Method, op.Expand(projectID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// board is the shape returned by the task listing: a project carrying its
// columns, each of which carries its tasks.
type board struct {
	Data struct {
		ID      string   `json:"id"`
		Name    string   `json:"name"`
		Columns []Column `json:"columns"`
	} `json:"data"`
}

// Board is a project together with its columns and tasks.
type Board struct {
	ProjectID   string
	ProjectName string
	Columns     []Column
}

// Tasks flattens the board, most urgent first, then by task number.
func (b Board) Tasks() []Task {
	var out []Task
	for _, col := range b.Columns {
		out = append(out, col.Tasks...)
	}
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := PriorityRank(out[i].Priority), PriorityRank(out[j].Priority)
		if pi != pj {
			return pi < pj
		}
		return out[i].Number < out[j].Number
	})
	return out
}

// GetBoard fetches a project's columns and tasks.
func (c *Client) GetBoard(ctx context.Context, projectID string) (*Board, error) {
	op := operation("listTasks")
	var raw board
	if err := c.Do(ctx, op.Method, op.Expand(projectID), nil, nil, &raw); err != nil {
		return nil, err
	}
	return &Board{
		ProjectID:   raw.Data.ID,
		ProjectName: raw.Data.Name,
		Columns:     raw.Data.Columns,
	}, nil
}

// GetTask fetches one task by id.
func (c *Client) GetTask(ctx context.Context, taskID string) (*Task, error) {
	op := operation("getTask")
	var out Task
	if err := c.Do(ctx, op.Method, op.Expand(taskID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetTaskStatus moves a task to another column.
//
// The dedicated endpoint is used rather than PUT /task/{id}, which requires
// every field and answers 400 when used for a partial update.
func (c *Client) SetTaskStatus(ctx context.Context, taskID, status string) error {
	op := operation("updateTaskStatus")
	return c.Do(ctx, op.Method, op.Expand(taskID), nil, map[string]string{"status": status}, nil)
}

// SetTaskPriority changes a task's priority.
func (c *Client) SetTaskPriority(ctx context.Context, taskID, priority string) error {
	op := operation("updateTaskPriority")
	return c.Do(ctx, op.Method, op.Expand(taskID), nil, map[string]string{"priority": priority}, nil)
}

// ListComments returns a task's comments oldest-first.
func (c *Client) ListComments(ctx context.Context, taskID string) ([]Comment, error) {
	op := operation("getTaskComments")
	var out []Comment
	if err := c.Do(ctx, op.Method, op.Expand(taskID), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AddComment posts a comment on a task.
func (c *Client) AddComment(ctx context.Context, taskID, content string) (*Comment, error) {
	op := operation("createTaskComment")
	var out Comment
	if err := c.Do(ctx, op.Method, op.Expand(taskID), nil, map[string]string{"content": content}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateTask adds a task to a project. The server requires description,
// priority and status on creation, so empty values are filled with defaults
// rather than omitted.
func (c *Client) CreateTask(ctx context.Context, projectID string, in NewTask) (*Task, error) {
	if in.Priority == "" {
		in.Priority = "medium"
	}
	if in.Status == "" {
		in.Status = "to-do"
	}
	op := operation("createTask")
	var out Task
	if err := c.Do(ctx, op.Method, op.Expand(projectID), nil, in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// NewTask is the payload for creating a task.
type NewTask struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
	Status      string `json:"status"`
	DueDate     string `json:"dueDate,omitempty"`
	AssigneeID  string `json:"assigneeId,omitempty"`
}

// DeleteTask removes a task.
func (c *Client) DeleteTask(ctx context.Context, taskID string) error {
	op := operation("deleteTask")
	return c.Do(ctx, op.Method, op.Expand(taskID), nil, nil, nil)
}

// SetTaskAssignee assigns a task to a user, or clears the assignee when
// userID is empty.
func (c *Client) SetTaskAssignee(ctx context.Context, taskID, userID string) error {
	op := operation("updateTaskAssignee")
	body := map[string]any{"assigneeId": any(userID)}
	if userID == "" {
		body["assigneeId"] = nil
	}
	return c.Do(ctx, op.Method, op.Expand(taskID), nil, body, nil)
}

// MoveTask moves a task to another project.
func (c *Client) MoveTask(ctx context.Context, taskID, projectID string) error {
	op := operation("moveTask")
	return c.Do(ctx, op.Method, op.Expand(taskID), nil, map[string]string{"projectId": projectID}, nil)
}

// NewProject is the payload for creating a project. The server requires an
// icon, so CreateProject supplies one when the caller does not.
type NewProject struct {
	Name        string `json:"name"`
	WorkspaceID string `json:"workspaceId"`
	Icon        string `json:"icon"`
	Slug        string `json:"slug,omitempty"`
	Description string `json:"description,omitempty"`
}

// CreateProject adds a project to a workspace.
func (c *Client) CreateProject(ctx context.Context, in NewProject) (*Project, error) {
	if in.Icon == "" {
		in.Icon = "Layers"
	}
	op := operation("createProject")
	var out Project
	if err := c.Do(ctx, op.Method, op.Expand(), nil, in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RelationTypes are the links the server accepts between two tasks.
var RelationTypes = []string{"subtask", "blocks", "related"}

// Relation links two tasks.
type Relation struct {
	ID           string `json:"id"`
	SourceTaskID string `json:"sourceTaskId"`
	TargetTaskID string `json:"targetTaskId"`
	RelationType string `json:"relationType"`
}

// LinkTasks relates two tasks. For a subtask link, source is the parent.
func (c *Client) LinkTasks(ctx context.Context, sourceTaskID, targetTaskID, relationType string) (*Relation, error) {
	op := operation("createTaskRelation")
	var out Relation
	body := map[string]string{
		"sourceTaskId": sourceTaskID,
		"targetTaskId": targetTaskID,
		"relationType": relationType,
	}
	if err := c.Do(ctx, op.Method, op.Expand(), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListRelations returns a task's links.
func (c *Client) ListRelations(ctx context.Context, taskID string) ([]Relation, error) {
	op := operation("getTaskRelations")
	var out []Relation
	if err := c.Do(ctx, op.Method, op.Expand(taskID), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// UnlinkTasks removes a relation by its own id.
func (c *Client) UnlinkTasks(ctx context.Context, relationID string) error {
	op := operation("deleteTaskRelation")
	return c.Do(ctx, op.Method, op.Expand(relationID), nil, nil, nil)
}
