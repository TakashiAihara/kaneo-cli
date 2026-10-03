import { apiKey, taskProject, type App } from "./app";
import { addComment, listComments, type Comment } from "../api/kaneo";
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
        const task = await resolveTask(taskProject(app), args[0]!);
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
        const task = await resolveTask(taskProject(app), args[0]!);
        const comment = await addComment(task.id, args.slice(1).join(" "));
        app.out.human(`commented on #${task.number}`);
        app.out.data(comment);
      },
    },
  ],
};