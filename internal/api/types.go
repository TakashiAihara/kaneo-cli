package api

// Workspace is a Kaneo workspace. The server models it as a better-auth
// organization, which is why the listing lives under /auth.
type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// Project belongs to exactly one workspace.
type Project struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
	WorkspaceID string `json:"workspaceId"`
	IsPublic    bool   `json:"isPublic"`

	// ArchivedAt is set once a project is finished. Archiving is how a
	// project leaves a board without anything being deleted, so the field is
	// a timestamp rather than a flag: it also says when.
	ArchivedAt *string `json:"archivedAt"`
}

// Archived reports whether this project has been put away.
func (p Project) Archived() bool { return p.ArchivedAt != nil }

// Column is a board column. Its ID doubles as the status value carried by every
// task in it, so there is no separate status vocabulary.
type Column struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Tasks []Task `json:"tasks"`
}

// Task is a single work item.
type Task struct {
	ID           string  `json:"id"`
	Number       int     `json:"number"`
	Title        string  `json:"title"`
	Description  string  `json:"description"`
	Status       string  `json:"status"`
	Priority     string  `json:"priority"`
	Position     int     `json:"position"`
	ProjectID    string  `json:"projectId"`
	AssigneeID   *string `json:"assigneeId"`
	AssigneeName *string `json:"assigneeName"`
	StartDate    *string `json:"startDate"`
	DueDate      *string `json:"dueDate"`
	CreatedAt    string  `json:"createdAt"`
	Labels       []Label `json:"labels"`
}

// Label is a workspace-scoped tag.
type Label struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// Comment is a note on a task. It is also where session metadata lives, since
// tasks have no custom fields.
type Comment struct {
	ID        string `json:"id"`
	Content   string `json:"content"`
	UserID    string `json:"userId"`
	UserName  string `json:"userName"`
	CreatedAt string `json:"createdAt"`
}

// Priority values accepted by the server, ordered most urgent first.
var Priorities = []string{"urgent", "high", "medium", "low", "no-priority"}

// PriorityRank orders tasks for display. Unknown values sort last.
func PriorityRank(p string) int {
	for i, known := range Priorities {
		if p == known {
			return i
		}
	}
	return len(Priorities)
}
