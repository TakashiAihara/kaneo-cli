import { apiKey, projects, type App } from "./app";
import { archived, boardTasks, getBoard, getProject, listComments, type Task } from "../api/kaneo";
import { noArgs, type RunContext } from "./args";
import { withProject } from "./lookup";
import { latestPerSession, parse, running } from "../session/marker";

// One session's record on a task, as the board reports it. nextStep is left out
// when there is none, the way an attachment leaves out what it does not know.
type BoardSession = {
  taskNumber: number;
  taskTitle: string;
  sessionId: string;
  host: string;
  branch: string;
  cwd: string;
  nextStep?: string;
};

type Report = {
  project: string;
  open: Task[];
  doneCount: number;
  sessions: BoardSession[];
};

// Prints the open tasks and which sessions hold them.
//
// It fails like every other command when nothing can be read. It used to be
// fail-open for a session-start hook, but no hook called it and the one caller
// that did (a script asking "is this session attached anywhere") could not tell
// an unconfigured directory or a missing key from an empty board (#16).
//
// A repository mapped to several projects gets one section per project. board is
// the only command that takes more than one: it reads, so there is no question
// of which board a write lands on.
//
// Archived projects are left out. Projects are made per plan, so a repository
// accumulates finished ones, and the alternative — dropping them from the repo
// map — would lose the record that the repository ever had that work.
export const boardCommand = {
  name: "board",
  short: "Show open tasks and the sessions working on them",
  args: noArgs("kaneo board"),
  flags: [
    {
      name: "archived",
      type: "bool" as const,
      usage: "include archived projects, which are left out by default",
      defaultValue: "false",
    },
  ],
  run: async ({ flags, app }: RunContext<App>) => {
    apiKey(app);
    const includeArchived = flags.archived === true;

    const reports: Report[] = [];
    for (const id of projects(app)) {
      if (!includeArchived) {
        // The board listing does not carry the archived flag, so the project
        // itself is read first. An archived project is not a failure — it is
        // finished work that has been put away, and skipping it is the whole
        // point of archiving it.
        let open;
        try {
          open = await withProject(id, (projectId) => getProject(projectId));
        } catch (e) {
          throw new Error(`project ${id}: ${(e as Error).message}`);
        }
        if (archived(open)) continue;
      }
      try {
        reports.push(await withProject(id, (projectId) => buildBoard(projectId)));
      } catch (e) {
        // A board with one project missing reads, to a caller, as that project
        // having nothing on it (#16).
        throw new Error(`project ${id}: ${(e as Error).message}`);
      }
    }

    let printed = 0;
    for (const report of reports) {
      // An empty board prints nothing, so the separator counts what was actually
      // written rather than what was fetched.
      if (report.open.length === 0 && report.doneCount === 0) continue;
      if (printed > 0) app.out.human("");
      printBoard(app, report);
      printed++;
    }

    app.out.data(reports);
  },
};

// Fetches one project's board and splits it into what is open, what is done, and
// which sessions hold a task.
const buildBoard = async (id: string): Promise<Report> => {
  const board = await getBoard(id);
  const open: Task[] = [];
  let done = 0;
  for (const task of boardTasks(board)) {
    if (task.status === "done") {
      done++;
      continue;
    }
    open.push(task);
  }

  // An empty board still owes a script its document, so it becomes a report with
  // nothing in it rather than no report at all.
  const sessions = open.length > 0 ? await collectSessions(open) : [];
  return { project: board.projectName, open, doneCount: done, sessions };
};

const printBoard = (app: App, report: Report): void => {
  app.out.human(`## ${report.project} (open ${report.open.length} / done ${report.doneCount})`);
  for (const task of report.open) {
    app.out.human(`- [${task.priority}] #${task.number} ${task.title} (${task.status})`);
  }
  if (report.sessions.length === 0) return;
  app.out.human("");
  app.out.human("### Sessions holding a task");
  for (const session of report.sessions) {
    app.out.human(
      `- #${session.taskNumber} ${session.taskTitle} — session ${short(session.sessionId)} @${session.host} branch=${session.branch}`,
    );
    if (session.nextStep !== undefined) app.out.human(`  - next: ${session.nextStep}`);
  }
};

// Reads each open task's comments for session markers. A task whose comments
// cannot be read fails the board: skipping it would report the session holding
// that task as not attached anywhere.
const collectSessions = async (tasks: Task[]): Promise<BoardSession[]> => {
  const out: BoardSession[] = [];
  for (const task of tasks) {
    let comments;
    try {
      comments = await listComments(task.id);
    } catch (e) {
      throw new Error(`comments for #${task.number}: ${(e as Error).message}`);
    }
    const markers = comments
      .map((comment) => parse(comment.content, comment.createdAt))
      .filter((marker) => marker !== undefined);
    for (const marker of running(latestPerSession(markers))) {
      out.push({
        taskNumber: task.number,
        taskTitle: task.title,
        sessionId: marker.sessionId,
        host: marker.host,
        branch: marker.branch,
        cwd: marker.cwd,
        nextStep: marker.nextStep === "" ? undefined : marker.nextStep,
      });
    }
  }
  return out;
};

// A session id is long and only its start is recognisable, which is what a
// reader needs to tell two apart on one line.
const short = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);