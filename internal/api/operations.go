package api

import (
	"context"
	"net/http"
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
	var out []Workspace
	if err := c.Do(ctx, http.MethodGet, "/auth/organization/list", nil, nil, &out); err != nil {
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
	var out []Project
	q := url.Values{"workspaceId": {workspaceID}}
	if err := c.Do(ctx, http.MethodGet, "/project", q, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// GetProject fetches one project by id.
func (c *Client) GetProject(ctx context.Context, projectID string) (*Project, error) {
	var out Project
	if err := c.Do(ctx, http.MethodGet, "/project/"+url.PathEscape(projectID), nil, nil, &out); err != nil {
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
	var raw board
	if err := c.Do(ctx, http.MethodGet, "/task/tasks/"+url.PathEscape(projectID), nil, nil, &raw); err != nil {
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
	var out Task
	if err := c.Do(ctx, http.MethodGet, "/task/"+url.PathEscape(taskID), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetTaskStatus moves a task to another column.
//
// The dedicated endpoint is used rather than PUT /task/{id}, which requires
// every field and answers 400 when used for a partial update.
func (c *Client) SetTaskStatus(ctx context.Context, taskID, status string) error {
	return c.Do(ctx, http.MethodPut, "/task/status/"+url.PathEscape(taskID), nil,
		map[string]string{"status": status}, nil)
}

// SetTaskPriority changes a task's priority.
func (c *Client) SetTaskPriority(ctx context.Context, taskID, priority string) error {
	return c.Do(ctx, http.MethodPut, "/task/priority/"+url.PathEscape(taskID), nil,
		map[string]string{"priority": priority}, nil)
}

// ListComments returns a task's comments oldest-first.
func (c *Client) ListComments(ctx context.Context, taskID string) ([]Comment, error) {
	var out []Comment
	if err := c.Do(ctx, http.MethodGet, "/comment/"+url.PathEscape(taskID), nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// AddComment posts a comment on a task.
func (c *Client) AddComment(ctx context.Context, taskID, content string) (*Comment, error) {
	var out Comment
	if err := c.Do(ctx, http.MethodPost, "/comment/"+url.PathEscape(taskID), nil,
		map[string]string{"content": content}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
