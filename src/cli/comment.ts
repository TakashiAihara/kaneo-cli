import { apiKey, type App } from "./app";
import {
  addComment,
  afterWrite,
  deleteComment,
  editComment,
  listComments,
  setTaskStatus,
  type Comment,
  type Task,
} from "../api/kaneo";
import { exactArgs, minimumArgs, type RunContext } from "./args";
import { readInput } from "./input";
import { readBack, resolveTask, taskAfterWrite } from "./task";
import { allowArchivedFlag, taskRef, writeAccess } from "./lookup";
import { shellWord } from "../output/output";

// A human line for one comment. The id first, as the other listings print it and
// as comment delete and update take it, then the timestamp, and the text with its
// later lines indented beneath, so a multi-line comment reads as one entry.
const commentLine = (comment: Comment): string =>
  `${comment.id}  ${comment.createdAt}  ${comment.content.replaceAll("\n", "\n  ")}`.trimEnd();

// The suggested command names the task by id: a number is resolved through the
// project settings of whoever pastes it, which may pick another project's task.
const noComment = (id: string, task: Task): string =>
  `no comment ${JSON.stringify(id)} on #${task.number}; see \`kaneo comment list ${shellWord(task.id)}\``;

export const commentCommand = {
  name: "comment",
  aliases: ["cmt"],
  short: "Work with task comments",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      use: "list <task>",
      short: "List a task's comments",
      args: exactArgs(1),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const comments = await listComments(task.id);
        for (const comment of comments) app.out.human(commentLine(comment));
        app.out.data(comments);
      },
    },
    {
      name: "add",
      use: "add <task> <text...>",
      short: "Add a comment to a task",
      long:
        "Add a comment to a task.\n\n" +
        "Several words are one comment: `comment add 1 looks wrong to me` is one\n" +
        "comment, not six. The text can also arrive on stdin or in a file, so the\n" +
        "task reference is all this requires.\n\n" +
        "--status moves the task to a column in the same invocation, the way\n" +
        "`task status` would: the column is written first, so a status the\n" +
        "project has no column for fails before the comment exists, and a\n" +
        "comment that then fails says the status already landed.",
      // Several words are one comment: `comment add 1 looks wrong to me` is one
      // comment, not six. The text can also arrive on stdin or in a file, so the
      // task reference is all this requires.
      args: minimumArgs(1),
      flags: [
        {
          name: "file",
          shorthand: "F",
          type: "string" as const,
          usage: "read the comment from a file; - reads stdin",
          defaultValue: "",
        },
        {
          name: "status",
          type: "string" as const,
          usage: "also move the task to this column, as `task status` would",
          defaultValue: "",
        },
        allowArchivedFlag,
      ],
      run: async ({ args, flags, changed, app }: RunContext<App>) => {
        const words = args.slice(1);
        const fromFile = changed.has("file");
        // A comment is written once: two sources would leave a reader unable to
        // tell which of them is the comment.
        if (fromFile && words.length > 0) {
          throw new Error("pass the comment as arguments or with --file, not both");
        }
        // A lone `-` is stdin, so a comment can be piped in as it was written
        // rather than through a substitution that eats its newlines and its $.
        const content = fromFile
          ? await readInput(String(flags.file ?? ""))
          : words.length === 1 && words[0] === "-"
            ? await readInput("-")
            : words.join(" ");
        // Read and judged before the task is looked up: a comment with nothing in
        // it is not worth a request to find out which task it would have gone to,
        // and the arguments alone are enough to know it is empty.
        if (content.trim() === "") throw new Error("empty comment");
        // An empty --status is a mistake, not a column, and is refused before
        // the key is asked for, as the empty comment above is.
        const status = changed.has("status") ? String(flags.status ?? "").trim() : "";
        if (changed.has("status") && status === "") throw new Error("--status is empty");
        apiKey(app);
        const slugs = new Map<string, string>();
        const task = await resolveTask(app, args[0]!, slugs, writeAccess(flags));
        if (status !== "") {
          // The column first: a status the project has no column for is refused
          // by the server before the comment exists, so a bad --status leaves
          // nothing behind. A comment that then fails says the status already
          // landed, the way `task update` reports its own partial writes.
          await setTaskStatus(task.id, status);
          let comment: Comment;
          try {
            comment = await addComment(task.id, content);
          } catch (e) {
            throw new Error(
              `#${task.number} was moved to ${JSON.stringify(status)}, but the comment failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          const after = await taskAfterWrite(task, "status was set");
          readBack("status", after.status, status);
          app.out.human(`#${after.number} -> ${after.status}`);
          app.out.human(`commented on #${task.number}`);
          app.out.data({ comment, task: after });
          return;
        }
        const comment = await afterWrite(
          `commented on #${task.number}`,
          `\`kaneo comment ls ${shellWord(taskRef(slugs.get(task.projectId), task.number, task.projectId, task.id))}\` shows it`,
          addComment(task.id, content),
        );
        app.out.human(`commented on #${task.number}`);
        app.out.data(comment);
      },
    },
    {
      name: "delete",
      aliases: ["rm"],
      use: "delete <task> <comment-id>",
      short: "Delete a comment from a task",
      long:
        "Delete a comment from a task.\n\n" +
        "The id is the comment's id, the first column of `kaneo comment list <task>`. The server\n" +
        "deletes only comments written by the account the API key belongs to.",
      // Unlike `task rm` there is no --yes: a task takes its comments with it,
      // while this removes the one comment named by a server-made random id,
      // which a typo does not turn into another valid one.
      args: exactArgs(2),
      flags: [allowArchivedFlag],
      run: async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!, undefined, writeAccess(flags));
        // The server finds the comment by id among the caller's own, on any
        // task. Naming the task as well, and checking the comment is on it,
        // keeps a wrong id from removing one of your comments somewhere else,
        // which is the slip this command exists to undo.
        const comment = (await listComments(task.id)).find((c) => c.id === args[1]);
        if (comment === undefined) {
          throw new Error(noComment(args[1]!, task));
        }
        await deleteComment(comment.id);
        app.out.human(`deleted comment ${comment.id} from #${task.number}`);
        app.out.human(commentLine(comment));
        app.out.data(comment);
      },
    },
    {
      name: "update",
      aliases: ["edit"],
      use: "update <task> <comment-id> <text...>",
      short: "Replace the text of a comment on a task",
      args: minimumArgs(3),
      flags: [allowArchivedFlag],
      run: async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!, undefined, writeAccess(flags));
        // The server edits by comment id alone. Checking the comment is on the
        // named task keeps a mistyped id from rewriting a comment elsewhere.
        const found = (await listComments(task.id)).find((c) => c.id === args[1]);
        if (found === undefined) {
          throw new Error(noComment(args[1]!, task));
        }
        const comment = await editComment(found, args.slice(2).join(" "));
        app.out.human(`edited comment ${comment.id} on #${task.number}`);
        app.out.data(comment);
      },
    },
  ],
};
