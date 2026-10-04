// Every server operation this client calls. The generated client is built for
// exactly these ids (openapi/transformer.ts drops the rest), and `api-check`
// compares them against a live server's document, so the check cannot drift
// from what the client does.
export type Operation = {
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  // The CLI surface that needs it, so a missing operation says what breaks.
  command: string;
};

export const OPERATIONS: Operation[] = [
  { id: "listOrganization", method: "GET", path: "/auth/organization/list", command: "kaneo whoami / workspace ls" },
  { id: "updateOrganization", method: "POST", path: "/auth/organization/update", command: "kaneo workspace rename" },
  { id: "listProjects", method: "GET", path: "/project", command: "kaneo project ls" },
  { id: "getProject", method: "GET", path: "/project/{id}", command: "kaneo project get" },
  { id: "createProject", method: "POST", path: "/project", command: "kaneo project create" },
  { id: "updateProject", method: "PUT", path: "/project/{id}", command: "kaneo project update" },
  { id: "archiveProject", method: "PUT", path: "/project/{id}/archive", command: "kaneo project archive" },
  { id: "unarchiveProject", method: "PUT", path: "/project/{id}/unarchive", command: "kaneo project unarchive" },
  { id: "getColumns", method: "GET", path: "/column/{projectId}", command: "kaneo column ls" },
  { id: "createColumn", method: "POST", path: "/column/{projectId}", command: "kaneo column create" },
  { id: "reorderColumns", method: "PUT", path: "/column/reorder/{projectId}", command: "kaneo column reorder" },
  { id: "updateColumn", method: "PUT", path: "/column/{id}", command: "kaneo column rename" },
  { id: "deleteColumn", method: "DELETE", path: "/column/{id}", command: "kaneo column rm" },
  { id: "listTasks", method: "GET", path: "/task/tasks/{projectId}", command: "kaneo task ls / board" },
  { id: "getTask", method: "GET", path: "/task/{id}", command: "kaneo task get" },
  { id: "createTask", method: "POST", path: "/task/{projectId}", command: "kaneo task create" },
  { id: "deleteTask", method: "DELETE", path: "/task/{id}", command: "kaneo task rm" },
  { id: "updateTaskStatus", method: "PUT", path: "/task/status/{id}", command: "kaneo task status" },
  { id: "updateTaskPriority", method: "PUT", path: "/task/priority/{id}", command: "kaneo task priority" },
  { id: "updateTaskAssignee", method: "PUT", path: "/task/assignee/{id}", command: "kaneo task assign" },
  { id: "moveTask", method: "PUT", path: "/task/move/{id}", command: "kaneo task move" },
  { id: "createTaskRelation", method: "POST", path: "/task-relation", command: "kaneo task link" },
  { id: "getTaskRelations", method: "GET", path: "/task-relation/{taskId}", command: "kaneo task links" },
  { id: "deleteTaskRelation", method: "DELETE", path: "/task-relation/{id}", command: "kaneo task unlink" },
  { id: "getTaskComments", method: "GET", path: "/comment/{taskId}", command: "kaneo comment ls / board" },
  { id: "createTaskComment", method: "POST", path: "/comment/{taskId}", command: "kaneo comment add / session" },
  { id: "deleteTaskComment", method: "DELETE", path: "/comment/{id}", command: "kaneo comment delete" },
  { id: "updateTaskComment", method: "PUT", path: "/comment/{id}", command: "kaneo comment edit" },
  { id: "getActivities", method: "GET", path: "/activity/{taskId}", command: "kaneo activity ls" },
  { id: "createActivity", method: "POST", path: "/activity/create", command: "kaneo activity add" },
  { id: "getWorkspaceLabels", method: "GET", path: "/label/workspace/{workspaceId}", command: "kaneo label ls / attach" },
  { id: "getTaskLabels", method: "GET", path: "/label/task/{taskId}", command: "kaneo label ls <task> / detach" },
  { id: "getLabel", method: "GET", path: "/label/{id}", command: "kaneo label get / update" },
  { id: "createLabel", method: "POST", path: "/label", command: "kaneo label create" },
  { id: "updateLabel", method: "PUT", path: "/label/{id}", command: "kaneo label update" },
  { id: "deleteLabel", method: "DELETE", path: "/label/{id}", command: "kaneo label rm" },
  { id: "attachLabelToTask", method: "PUT", path: "/label/{id}/task", command: "kaneo label attach" },
  { id: "detachLabelFromTask", method: "DELETE", path: "/label/{id}/task", command: "kaneo label detach" },
];
