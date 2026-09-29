package api

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/TakashiAihara/kaneo-cli/internal/api/gen"
)

// ListWorkspaces returns the workspaces the key can see.
//
// This is also the only cheap call that can tell a valid key from an invalid
// one. /auth/get-session answers 200 with null for a valid key, an invalid key
// and no key at all, so it has no discriminating power and must not be used to
// check credentials.
func (c *Client) ListWorkspaces(ctx context.Context) ([]Workspace, error) {
	resp, err := c.gen.ListOrganization(ctx)
	if err != nil {
		return nil, unwrap(err)
	}
	out := make([]Workspace, 0, len(*resp))
	for _, o := range *resp {
		out = append(out, Workspace{ID: o.ID, Name: o.Name, Slug: o.Slug})
	}
	return out, nil
}

// VerifyKey reports whether the configured key is accepted.
func (c *Client) VerifyKey(ctx context.Context) error {
	_, err := c.ListWorkspaces(ctx)
	return err
}

// RenameWorkspace changes a workspace's display name. better-auth only touches
// the slug when data.slug is sent, and Kaneo's own settings page sends the same
// name-only payload, so a CLI rename matches a UI rename.
//
// The server accepts any 1-character name, including a space, so the name is
// trimmed and checked here. The reply is checked too: a 200 that does not echo
// the workspace back must not read as success.
func (c *Client) RenameWorkspace(ctx context.Context, workspaceID, name string) (*Workspace, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("workspace name is empty")
	}

	resp, err := c.gen.UpdateOrganization(ctx, &gen.UpdateOrganizationRequestOptions{Body: &gen.UpdateOrganizationBody{
		OrganizationID: &workspaceID,
		Data:           gen.UpdateOrganizationBody_Data{Name: &name},
	}})
	if err != nil {
		return nil, unwrap(err)
	}
	if resp.ID != workspaceID || resp.Name != name {
		return nil, fmt.Errorf("/auth/organization/update: server answered with workspace %q named %q", resp.ID, resp.Name)
	}
	return &Workspace{ID: resp.ID, Name: resp.Name, Slug: resp.Slug}, nil
}

// ListProjects returns the projects in a workspace. workspaceId is a required
// query parameter; omitting it is a 400, not an unfiltered listing.
//
// Archived projects are left out unless asked for, which is the same view the
// board takes.
func (c *Client) ListProjects(ctx context.Context, workspaceID string, includeArchived bool) ([]Project, error) {
	q := &gen.ListProjectsQuery{WorkspaceID: workspaceID}
	if includeArchived {
		yes := "true"
		q.IncludeArchived = &yes
	}
	resp, err := c.gen.ListProjects(ctx, &gen.ListProjectsRequestOptions{Query: q})
	if err != nil {
		return nil, unwrap(err)
	}
	out := make([]Project, 0, len(*resp))
	for _, p := range *resp {
		out = append(out, Project{
			ID: p.ID, Name: p.Name, Slug: p.Slug, Icon: deref(p.Icon), Description: deref(p.Description),
			WorkspaceID: p.WorkspaceID, IsPublic: derefBool(p.IsPublic), ArchivedAt: isoTimePtr(p.ArchivedAt),
		})
	}
	return out, nil
}

func projectFrom(p *gen.Project) *Project {
	return &Project{
		ID: p.ID, Name: p.Name, Slug: p.Slug, Icon: deref(p.Icon), Description: deref(p.Description),
		WorkspaceID: p.WorkspaceID, IsPublic: derefBool(p.IsPublic), ArchivedAt: isoTimePtr(p.ArchivedAt),
	}
}

// SetProjectArchived puts a project away, or brings it back.
//
// Archiving is the alternative to editing a project out of the repo map: the
// mapping and every task on it stay where they are, and only the board stops
// showing it. Nothing is deleted, so the change is reversible.
func (c *Client) SetProjectArchived(ctx context.Context, projectID string, archived bool) error {
	var err error
	if archived {
		_, err = c.gen.ArchiveProject(ctx, &gen.ArchiveProjectRequestOptions{PathParams: &gen.ArchiveProjectPath{ID: esc(projectID)}})
	} else {
		_, err = c.gen.UnarchiveProject(ctx, &gen.UnarchiveProjectRequestOptions{PathParams: &gen.UnarchiveProjectPath{ID: esc(projectID)}})
	}
	return unwrap(err)
}

// GetProject fetches one project by id.
func (c *Client) GetProject(ctx context.Context, projectID string) (*Project, error) {
	resp, err := c.gen.GetProject(ctx, &gen.GetProjectRequestOptions{PathParams: &gen.GetProjectPath{ID: esc(projectID)}})
	if err != nil {
		return nil, unwrap(err)
	}
	return projectFrom(resp), nil
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

// GetBoard fetches a project's columns and tasks, every page of them.
//
// Two levels of paging, as v2.29.2 serves the listing:
//   - task pages (page): 50 tasks each, in a stable order
//   - within a task page, related pages (relatedPage): the same tasks again,
//     with the next 100 labels, links and columns
//
// Tasks are keyed by id, so a task seen again on a related page only gains the
// labels that page carries, and columns are merged by id in the order they
// first appear.
//
// The first request sends neither page nor limit. A release from before
// v2.29.2 paginates only when one of them is present, and there it sorts on
// position alone, which ties within a column and so pages unstably; left
// without them it returns the whole board at once, as it always did.
func (c *Client) GetBoard(ctx context.Context, projectID string) (*Board, error) {
	var b *Board
	columns := map[string]int{}
	type at struct{ col, task int }
	tasks := map[string]at{}

	for page, pages := 1, 1; page <= pages; page++ {
		for related, relatedPages := 1, 1; related <= relatedPages; related++ {
			q := &gen.ListTasksQuery{}
			if page > 1 {
				p := page
				q.Page = &p
			}
			if related > 1 {
				r := related
				q.RelatedPage = &r
				if page == 1 {
					one := 1
					q.Page = &one
				}
			}
			resp, err := c.gen.ListTasks(ctx, &gen.ListTasksRequestOptions{
				PathParams: &gen.ListTasksPath{ProjectID: esc(projectID)},
				Query:      q,
			})
			if err != nil {
				return nil, unwrap(err)
			}
			pages = int(resp.Pagination.TotalPages)
			relatedPages = int(resp.Pagination.RelatedTotalPages)

			if b == nil {
				b = &Board{ProjectID: resp.Data.ID, ProjectName: resp.Data.Name}
			}
			for _, col := range resp.Data.Columns {
				ci, ok := columns[col.ID]
				if !ok {
					ci = len(b.Columns)
					columns[col.ID] = ci
					b.Columns = append(b.Columns, Column{ID: col.ID, Name: col.Name})
				}
				for _, t := range col.Tasks {
					if seen, ok := tasks[t.ID]; ok {
						// A repeat on a related page brings more labels; a
						// repeat on a later task page is the same task twice.
						if related > 1 {
							dst := &b.Columns[seen.col].Tasks[seen.task]
							dst.Labels = append(dst.Labels, labelsFrom(t.Labels)...)
						}
						continue
					}
					tasks[t.ID] = at{ci, len(b.Columns[ci].Tasks)}
					b.Columns[ci].Tasks = append(b.Columns[ci].Tasks, boardTask(t))
				}
			}
		}
	}
	return b, nil
}

func labelsFrom(in []gen.TaskLabel) []Label {
	out := make([]Label, 0, len(in))
	for _, l := range in {
		out = append(out, Label{ID: l.ID, Name: l.Name, Color: l.Color})
	}
	return out
}

func boardTask(t gen.BoardTask) Task {
	labels := labelsFrom(t.Labels)
	return Task{
		ID: t.ID, Number: toInt(t.Number), Title: t.Title, Description: deref(t.Description),
		Status: t.Status, Priority: t.Priority, Position: toInt(t.Position), ProjectID: t.ProjectID,
		AssigneeID: t.AssigneeID, AssigneeName: t.AssigneeName,
		StartDate: isoTimePtr(t.StartDate), DueDate: isoTimePtr(t.DueDate), CreatedAt: isoTime(t.CreatedAt),
		Labels: labels,
	}
}

// taskFrom maps a task as the write routes return it. Those carry the assignee
// as userId and no name.
func taskFrom(t *gen.Task) *Task {
	return &Task{
		ID: t.ID, Number: toInt(t.Number), Title: t.Title, Description: deref(t.Description),
		Status: t.Status, Priority: t.Priority, Position: toInt(t.Position), ProjectID: t.ProjectID,
		AssigneeID: t.UserID,
		StartDate:  isoTimePtr(t.StartDate), DueDate: isoTimePtr(t.DueDate), CreatedAt: isoTime(t.CreatedAt),
	}
}

// GetTask fetches one task by id.
func (c *Client) GetTask(ctx context.Context, taskID string) (*Task, error) {
	t, err := c.gen.GetTask(ctx, &gen.GetTaskRequestOptions{PathParams: &gen.GetTaskPath{ID: esc(taskID)}})
	if err != nil {
		return nil, unwrap(err)
	}
	return &Task{
		ID: t.ID, Number: toInt(t.Number), Title: t.Title, Description: deref(t.Description),
		Status: t.Status, Priority: t.Priority, Position: toInt(t.Position), ProjectID: t.ProjectID,
		AssigneeID: t.AssigneeID, AssigneeName: t.AssigneeName,
		StartDate: isoTimePtr(t.StartDate), DueDate: isoTimePtr(t.DueDate), CreatedAt: isoTime(t.CreatedAt),
	}, nil
}

// SetTaskStatus moves a task to another column.
//
// The dedicated endpoint is used rather than PUT /task/{id}, which requires
// every field and answers 400 when used for a partial update.
func (c *Client) SetTaskStatus(ctx context.Context, taskID, status string) error {
	_, err := c.gen.UpdateTaskStatus(ctx, &gen.UpdateTaskStatusRequestOptions{
		PathParams: &gen.UpdateTaskStatusPath{ID: esc(taskID)},
		Body:       &gen.UpdateTaskStatusBody{Status: status},
	})
	return unwrap(err)
}

// SetTaskPriority changes a task's priority.
func (c *Client) SetTaskPriority(ctx context.Context, taskID, priority string) error {
	_, err := c.gen.UpdateTaskPriority(ctx, &gen.UpdateTaskPriorityRequestOptions{
		PathParams: &gen.UpdateTaskPriorityPath{ID: esc(taskID)},
		Body:       &gen.UpdateTaskPriorityBody{Priority: gen.UpdateTaskPriorityBodyPriority(priority)},
	})
	return unwrap(err)
}

// ListComments returns a task's comments oldest-first.
func (c *Client) ListComments(ctx context.Context, taskID string) ([]Comment, error) {
	resp, err := c.gen.GetTaskComments(ctx, &gen.GetTaskCommentsRequestOptions{PathParams: &gen.GetTaskCommentsPath{TaskID: esc(taskID)}})
	if err != nil {
		return nil, unwrap(err)
	}
	out := make([]Comment, 0, len(*resp))
	for _, cm := range *resp {
		out = append(out, Comment{ID: cm.ID, Content: cm.Content, UserID: cm.UserID, UserName: cm.User.Name, CreatedAt: isoTime(cm.CreatedAt)})
	}
	return out, nil
}

// AddComment posts a comment on a task. The server answers with the stored
// activity row, which names no author.
func (c *Client) AddComment(ctx context.Context, taskID, content string) (*Comment, error) {
	a, err := c.gen.CreateTaskComment(ctx, &gen.CreateTaskCommentRequestOptions{
		PathParams: &gen.CreateTaskCommentPath{TaskID: esc(taskID)},
		Body:       &gen.CreateTaskCommentBody{Content: content},
	})
	if err != nil {
		return nil, unwrap(err)
	}
	return &Comment{ID: a.ID, Content: deref(a.Content), UserID: deref(a.UserID), CreatedAt: isoTime(a.CreatedAt)}, nil
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
	body := &gen.CreateTaskBody{
		Title: in.Title, Description: in.Description,
		Priority: gen.CreateTaskBodyPriority(in.Priority), Status: in.Status,
		DueDate: nonEmpty(in.DueDate), UserID: nonEmpty(in.AssigneeID),
	}
	t, err := c.gen.CreateTask(ctx, &gen.CreateTaskRequestOptions{PathParams: &gen.CreateTaskPath{ProjectID: esc(projectID)}, Body: body})
	if err != nil {
		return nil, unwrap(err)
	}
	return taskFrom(t), nil
}

// NewTask is the payload for creating a task.
type NewTask struct {
	Title       string
	Description string
	Priority    string
	Status      string
	DueDate     string
	AssigneeID  string
}

// DeleteTask removes a task.
func (c *Client) DeleteTask(ctx context.Context, taskID string) error {
	_, err := c.gen.DeleteTask(ctx, &gen.DeleteTaskRequestOptions{PathParams: &gen.DeleteTaskPath{ID: esc(taskID)}})
	return unwrap(err)
}

// SetTaskAssignee assigns a task to a user, or clears the assignee when
// userID is empty.
func (c *Client) SetTaskAssignee(ctx context.Context, taskID, userID string) error {
	_, err := c.gen.UpdateTaskAssignee(ctx, &gen.UpdateTaskAssigneeRequestOptions{
		PathParams: &gen.UpdateTaskAssigneePath{ID: esc(taskID)},
		Body:       &gen.UpdateTaskAssigneeBody{UserID: nonEmpty(userID)},
	})
	return unwrap(err)
}

// MoveTask moves a task to another project.
func (c *Client) MoveTask(ctx context.Context, taskID, projectID string) error {
	_, err := c.gen.MoveTask(ctx, &gen.MoveTaskRequestOptions{
		PathParams: &gen.MoveTaskPath{ID: esc(taskID)},
		Body:       &gen.MoveTaskBody{DestinationProjectID: projectID},
	})
	return unwrap(err)
}

// NewProject is the payload for creating a project. The server requires an
// icon, so CreateProject supplies one when the caller does not.
//
// The server's create route takes no description, so Description is not sent;
// it is kept so a caller can set it with UpdateProject afterwards.
type NewProject struct {
	Name        string
	WorkspaceID string
	Icon        string
	Slug        string
	Description string
}

// CreateProject adds a project to a workspace.
func (c *Client) CreateProject(ctx context.Context, in NewProject) (*Project, error) {
	if in.Icon == "" {
		in.Icon = "Layers"
	}
	p, err := c.gen.CreateProject(ctx, &gen.CreateProjectRequestOptions{Body: &gen.CreateProjectBody{
		Name: in.Name, WorkspaceID: in.WorkspaceID, Icon: in.Icon, Slug: in.Slug,
	}})
	if err != nil {
		return nil, unwrap(err)
	}
	return projectFrom(p), nil
}

// ProjectChanges names the fields to change. A nil field is left as it is.
type ProjectChanges struct {
	Name        *string
	Slug        *string
	Description *string
	Icon        *string
}

// UpdateProject changes only the fields set in ch.
//
// The server's update is a full replace: name, icon, slug, description and
// isPublic are all required, and whatever is sent is written. So the project is
// read first and every field that was not asked for, visibility included, is
// sent back as it was when read; a change made elsewhere between the read and
// the write is overwritten. Sending isPublic unchanged also keeps the call clear
// of the project:share permission, which the server demands only on a change.
//
// A NULL description comes back as "" and is written as "": the server's body
// takes only a string, so NULL cannot be sent back. Both render the same.
//
// It returns the project as read and as written, so a caller can show both.
func (c *Client) UpdateProject(ctx context.Context, projectID string, ch ProjectChanges) (before, after *Project, err error) {
	// The server accepts any string, but a blank name, slug or icon leaves a
	// project that cannot be read or linked to, so those are refused here.
	for _, f := range []struct {
		name string
		v    **string
	}{{"name", &ch.Name}, {"slug", &ch.Slug}, {"icon", &ch.Icon}} {
		if *f.v == nil {
			continue
		}
		s := strings.TrimSpace(**f.v)
		if s == "" {
			return nil, nil, fmt.Errorf("project %s is empty", f.name)
		}
		*f.v = &s
	}

	if before, err = c.GetProject(ctx, projectID); err != nil {
		return nil, nil, err
	}
	// Every field of this read is written back, so a read that decoded to an
	// empty project (a null reply, a different shape) would blank the project.
	if before.ID != projectID || before.Name == "" || before.Slug == "" {
		return nil, nil, fmt.Errorf("reading project %s before the update got id %q, name %q, slug %q; not writing", projectID, before.ID, before.Name, before.Slug)
	}
	want := *before
	for _, f := range []struct {
		to   *string
		from *string
	}{{&want.Name, ch.Name}, {&want.Slug, ch.Slug}, {&want.Description, ch.Description}, {&want.Icon, ch.Icon}} {
		if f.from != nil {
			*f.to = *f.from
		}
	}

	resp, err := c.gen.UpdateProject(ctx, &gen.UpdateProjectRequestOptions{
		PathParams: &gen.UpdateProjectPath{ID: esc(projectID)},
		Body: &gen.UpdateProjectBody{
			Name: want.Name, Icon: want.Icon, Slug: want.Slug, Description: want.Description, IsPublic: want.IsPublic,
		},
	})
	if err != nil {
		return nil, nil, unwrap(err)
	}
	out := projectFrom(resp)
	var off []string
	for _, f := range []struct {
		name      string
		got, want any
	}{
		{"id", out.ID, projectID}, {"name", out.Name, want.Name}, {"slug", out.Slug, want.Slug},
		{"description", out.Description, want.Description}, {"icon", out.Icon, want.Icon},
		{"isPublic", out.IsPublic, want.IsPublic},
	} {
		if f.got != f.want {
			off = append(off, fmt.Sprintf("%s %q, want %q", f.name, fmt.Sprint(f.got), fmt.Sprint(f.want)))
		}
	}
	if len(off) > 0 {
		return nil, nil, fmt.Errorf("/project/%s: server did not echo the update: %s", projectID, strings.Join(off, "; "))
	}
	return before, out, nil
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
	r, err := c.gen.CreateTaskRelation(ctx, &gen.CreateTaskRelationRequestOptions{Body: &gen.CreateTaskRelationBody{
		SourceTaskID: sourceTaskID, TargetTaskID: targetTaskID,
		RelationType: gen.CreateTaskRelationBodyRelationType(relationType),
	}})
	if err != nil {
		return nil, unwrap(err)
	}
	return &Relation{ID: r.ID, SourceTaskID: r.SourceTaskID, TargetTaskID: r.TargetTaskID, RelationType: r.RelationType}, nil
}

// ListRelations returns a task's links.
func (c *Client) ListRelations(ctx context.Context, taskID string) ([]Relation, error) {
	resp, err := c.gen.GetTaskRelations(ctx, &gen.GetTaskRelationsRequestOptions{PathParams: &gen.GetTaskRelationsPath{TaskID: esc(taskID)}})
	if err != nil {
		return nil, unwrap(err)
	}
	out := make([]Relation, 0, len(*resp))
	for _, r := range *resp {
		out = append(out, Relation{ID: r.ID, SourceTaskID: r.SourceTaskID, TargetTaskID: r.TargetTaskID, RelationType: r.RelationType})
	}
	return out, nil
}

// UnlinkTasks removes a relation by its own id.
func (c *Client) UnlinkTasks(ctx context.Context, relationID string) error {
	_, err := c.gen.DeleteTaskRelation(ctx, &gen.DeleteTaskRelationRequestOptions{PathParams: &gen.DeleteTaskRelationPath{ID: esc(relationID)}})
	return unwrap(err)
}

// isoLayout is how the server writes timestamps (JavaScript's toISOString:
// UTC, milliseconds), so a time read and printed again comes out as the server
// sent it. A timestamp written any other way, with an offset or finer than
// milliseconds, is printed as the same instant in this form.
const isoLayout = "2006-01-02T15:04:05.000Z07:00"

func isoTime(t time.Time) string { return t.UTC().Format(isoLayout) }

func isoTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := isoTime(*t)
	return &s
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefBool(b *bool) bool { return b != nil && *b }

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// toInt reads a task number or position. The document types them as number
// (read as float64, exact for any integer the server issues); the server only
// issues integers.
func toInt(f *float64) int {
	if f == nil {
		return 0
	}
	return int(*f)
}
