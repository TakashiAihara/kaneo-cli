import { apiKey, project, type App } from "./app";
import {
  deleteWorkflowRule,
  listWorkflowRules,
  setWorkflowRule,
  type WorkflowRule,
} from "../api/kaneo";
import { KaneoApiError } from "../api/http";
import { minimumArgs, noArgs, rangeArgs, type RunContext } from "./args";
import { resolveColumn } from "./column";
import { withProject } from "./lookup";

// The integrations Kaneo ships a plugin for, and the events those plugins look a
// column up by: upstream's plugins/*/utils/resolve-column.ts is the file their
// callers ask, so these are the pairs a rule has to be written in to move
// anything. The server stores any pair it is given, so one outside these lists is
// stored and warned about rather than refused — a later release may add a name
// this build has not heard of.
const INTEGRATIONS = ["github", "gitea", "gitlab"];
const EVENTS = ["branch_push", "pr_opened", "pr_merged", "issue_opened", "issue_closed", "issue_reopened"];

// The rules that move a task on when something happens outside the board, and the
// changes to them.
export const workflowCommand = {
  name: "workflow",
  aliases: ["rule"],
  short: "Work with a project's integration rules",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List a project's workflow rules",
      long:
        "List a project's workflow rules.\n\n" +
        "A rule says which column a task lands in when an integration's event fires.\n" +
        "The integration and the event are Kaneo's own names, the ones its plugins\n" +
        "fire, and not the provider's webhook names; `kaneo workflow set --help`\n" +
        "lists them.",
      args: noArgs("kaneo workflow list"),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const rules = await withProject(project(app), (id) => listWorkflowRules(id));
        for (const rule of rules) app.out.human(ruleLine(rule));
        app.out.data(rules);
      },
    },
    {
      name: "set",
      use: "set <integration> <event> <column>",
      short: "Send a task to a column when an integration's event fires",
      long:
        "Send a task to a column when an integration's event fires.\n\n" +
        `The integration is one of ${INTEGRATIONS.join(", ")}; the event one of:\n` +
        `${EVENTS.slice(0, 3).join(", ")},\n${EVENTS.slice(3).join(", ")}.\n` +
        "Those are Kaneo's own names, the ones its plugins fire, and not the\n" +
        "provider's webhook names. The column is a column of this project, by id,\n" +
        "slug or name, and its name may be several words.",
      // Three at least: the integration and the event are one word each, and the
      // rest is the column, which is the one name here that may be written in
      // several words (`column create Waiting on review`).
      args: minimumArgs(3),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        const integrationType = args[0]!.trim();
        const eventType = args[1]!.trim();
        // A pair with a blank half is a rule nothing can ever match, and the
        // server would store it rather than say so.
        if (integrationType === "" || eventType === "") {
          throw new Error("an integration and an event are both needed");
        }
        const { projectId, column } = await withProject(project(app), async (projectId) => ({
          projectId,
          column: await resolveColumn(projectId, args.slice(2).join(" ")),
        }));
        // The server's upsert looks for a rule the project already has for the
        // pair and moves its column, so setting a pair again is a move rather
        // than a second rule.
        const rule = await setWorkflowRule(projectId, {
          integrationType,
          eventType,
          columnId: column.id,
        });
        // Said only once the rule is stored, so the line matches what happened.
        warnUnfired(app, integrationType, eventType);
        app.out.human(`${integrationType} ${eventType} -> ${column.slug}`);
        app.out.data(rule);
      },
    },
    {
      name: "rm",
      use: "rm <rule-id> | rm <integration> <event>",
      short: "Delete a workflow rule, by id or by the pair it names",
      long:
        "Delete a workflow rule.\n\n" +
        "One word is the rule's id from `kaneo workflow ls --json`, and the rule is\n" +
        "deleted wherever it is: the route takes the rule's own id, so that form\n" +
        "needs no project. Two words are the integration and the event it was set\n" +
        "for, and are looked for in the resolved project.",
      // Unlike `column rm` there is no --yes: nothing refers to a rule's id, and
      // `workflow set` with the same pair puts the rule back as it was.
      args: rangeArgs(1, 2),
      run: async ({ args, app }: RunContext<App>) => {
        apiKey(app);
        const [first, second] = args;
        if (second !== undefined) {
          const integrationType = first!.trim();
          const eventType = second.trim();
          const rule = await withProject(project(app), (id) => ruleFor(id, integrationType, eventType));
          const deleted = await deleteWorkflowRule(rule.id);
          // The pair this branch was given, which is what named the rule; the
          // reply carries the same two words.
          app.out.human(`deleted workflow rule ${integrationType} ${eventType}`);
          app.out.data(deleted);
          return;
        }
        // No project is asked for on this path: the settings may name none, and
        // the id alone is what the delete takes.
        const id = first!.trim();
        // A blank id would address the collection route rather than a rule.
        if (id === "") throw new Error("a rule id cannot be blank");
        const deleted = await deleteWorkflowRule(id).catch((err: unknown) => {
          // The server's middleware looks the rule up to place its workspace
          // before the route runs, so an unknown one is its 400 rather than
          // anything naming a rule.
          if (err instanceof KaneoApiError && err.statusCode === 400 && err.messages.some((m) => m.includes("Workspace ID could not be determined"))) {
            throw new Error(`no workflow rule ${id}; kaneo workflow ls --json lists the ids`);
          }
          throw err;
        });
        // The id reaches a rule in any project the key can see, so the line says
        // which project it was in.
        app.out.human(`deleted workflow rule ${deleted.integrationType} ${deleted.eventType} from ${deleted.projectId}`);
        app.out.data(deleted);
      },
    },
  ],
};

// A pair nothing here fires, said once on stderr so that a rule which moves
// nothing is not read as one that works. Not a refusal: the server takes any
// pair, and a later release may fire a name this build has not heard of, which
// a refusal would refuse for good.
const warnUnfired = (app: App, integrationType: string, eventType: string): void => {
  if (!INTEGRATIONS.includes(integrationType)) {
    app.out.status(
      `warning: Kaneo ships no integration for ${integrationType} (known integrations: ${INTEGRATIONS.join(", ")}); the rule is stored but will not move a task`,
    );
    return;
  }
  if (!EVENTS.includes(eventType)) {
    app.out.status(
      `warning: Kaneo fires ${eventType} for no integration it ships (known events: ${EVENTS.join(", ")}); the rule is stored but will not move a task`,
    );
  }
};

// One rule as a person reads it: where the tasks it catches end up, and which
// rule that is, so it can be deleted by id. The column's id stands in for the
// column's slug when the listing's join found no column, which the column
// cascade rules out; it is still what the line has to print rather than nothing.
const ruleLine = (rule: WorkflowRule): string =>
  `${rule.integrationType} ${rule.eventType} -> ${rule.columnSlug ?? rule.columnId}  (${rule.id})`;

// The rule a pair names, or a refusal naming the listing to read.
//
// The pair is what the server looks a rule up by, so it is enough to find one and
// says which rule it is; a pair the project holds none for cannot be deleted by
// anything, since the delete route takes an id. Nothing on the server keeps one
// rule per pair — the upsert is a find followed by an insert — so a project can
// hold two for one pair, and deleting either would leave the other live. Both are
// named rather than one of them picked.
const ruleFor = async (projectId: string, integrationType: string, eventType: string): Promise<WorkflowRule> => {
  const found = (await listWorkflowRules(projectId)).filter(
    (rule) => rule.integrationType === integrationType && rule.eventType === eventType,
  );
  if (found.length === 0) {
    throw new Error(
      `no workflow rule for ${integrationType} ${eventType} in this project; kaneo workflow ls lists them`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `${found.length} workflow rules for ${integrationType} ${eventType}; delete one by id (${found.map((rule) => rule.id).join(", ")})`,
    );
  }
  return found[0]!;
};