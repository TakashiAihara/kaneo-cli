import { apiKey, type App } from "./app";
import { addComment, deleteComment, editComment, listComments, type Comment } from "../api/kaneo";
import { exactArgs, minimumArgs, type RunContext } from "./args";
import { resolveTask } from "./task";

// A human line for one comment. The timestamp first and the text indented
// beneath it, so a multi-line comment reads as belonging to one moment.
const commentLine = (comment: Comment): string =>
  `${comment.createdAt}  ${comment.content.replaceAll("\n", "\n  ")}`;

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
      // Several words are one comment: `comment add 1 looks wrong to me` is one
      // comment, not six.
      args: minimumArgs(2),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        const comment = await addComment(task.id, args.slice(1).join(" "));
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
        "The id is the comment's id from `kaneo comment list <task> --json`. The server\n" +
        "deletes only comments written by the account the API key belongs to.",
      // Unlike `task rm` there is no --yes: a task takes its comments with it,
      // while this removes the one comment named by a server-made random id,
      // which a typo does not turn into another valid one.
      args: exactArgs(2),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        // The server finds the comment by id among the caller's own, on any
        // task. Naming the task as well, and checking the comment is on it,
        // keeps a wrong id from removing one of your comments somewhere else,
        // which is the slip this command exists to undo.
        const comment = (await listComments(task.id)).find((c) => c.id === args[1]);
        if (comment === undefined) {
          throw new Error(`no comment ${JSON.stringify(args[1])} on #${task.number}; see \`kaneo comment list ${task.number} --json\``);
        }
        await deleteComment(comment.id);
        app.out.human(`deleted comment ${comment.id} from #${task.number}`);
        app.out.human(commentLine(comment));
        app.out.data(comment);
      },
    },
    {
      name: "edit",
      use: "edit <task> <comment-id> <text...>",
      short: "Replace the text of a comment on a task",
      args: minimumArgs(3),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        const task = await resolveTask(app, args[0]!);
        // The server edits by comment id alone. Checking the comment is on the
        // named task keeps a mistyped id from rewriting a comment elsewhere.
        const found = (await listComments(task.id)).find((c) => c.id === args[1]);
        if (found === undefined) {
          throw new Error(`no comment ${JSON.stringify(args[1])} on #${task.number}; see \`kaneo comment list ${task.number} --json\``);
        }
        const comment = await editComment(found, args.slice(2).join(" "));
        app.out.human(`edited comment ${comment.id} on #${task.number}`);
        app.out.data(comment);
      },
    },
  ],
};