import { apiKey, type App } from "./app";
import {
  clearNotifications,
  createNotification,
  getNotificationPreferences,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  removeWorkspaceRule,
  setWorkspaceRule,
  updateNotificationPreferences,
  type Notification,
  type NotificationPreferenceChanges,
  type NotificationPreferences,
  type WorkspaceRule,
} from "../api/kaneo";
import { exactArgs, minimumArgs, noArgs, type FlagValues, type RunContext } from "./args";
import type { Json } from "../output/json";

// A generated notification has no text of its own, only a type and the event
// it came from, so the type is always shown, and the task the event is about
// stands in for the text when there is none.
const notificationLine = (n: Notification): string => {
  const taskTitle = (n.eventData as { taskTitle?: unknown } | null)?.taskTitle;
  const text = [n.title, n.content].filter((t) => t).join(": ") || (typeof taskTitle === "string" ? taskTitle : "");
  return [n.id, n.createdAt, n.isRead ? "read  " : "unread", n.type, text].join("  ").trimEnd();
};

const onOff = (enabled: boolean): string => (enabled ? "on " : "off");

const preferenceLines = (p: NotificationPreferences): string[] => {
  const lines = [
    `email               ${onOff(p.emailEnabled)}  ${p.emailAddress ?? ""}`,
    `ntfy                ${onOff(p.ntfyEnabled)}  ${[p.ntfyServerUrl, p.ntfyTopic, p.maskedNtfyToken].filter((v) => v).join("  ")}`,
    `gotify              ${onOff(p.gotifyEnabled)}  ${[p.gotifyServerUrl, p.maskedGotifyToken].filter((v) => v).join("  ")}`,
    `webhook             ${onOff(p.webhookEnabled)}  ${[p.webhookUrl, p.maskedWebhookSecret].filter((v) => v).join("  ")}`,
    `task-assignment     ${onOff(p.taskAssignmentEnabled)}`,
    `task-comment        ${onOff(p.taskCommentEnabled)}`,
    `task-status-change  ${onOff(p.taskStatusChangeEnabled)}`,
    `due-date-reminder   ${onOff(p.dueDateReminderEnabled)}  ${p.dueDateReminderLeadTimeMinutes}m before`,
  ].map((line) => line.trimEnd());
  for (const rule of p.workspaces ?? []) lines.push(ruleLine(rule));
  return lines;
};

const ruleLine = (rule: WorkspaceRule & { workspaceId: string; workspaceName?: string }): string => {
  const channels = (["email", "ntfy", "gotify", "webhook"] as const).filter((c) => rule[`${c}Enabled`]);
  const projects = rule.projectMode === "all" ? "all" : (rule.selectedProjectIds ?? []).join(",");
  return [
    `workspace ${rule.workspaceId}`,
    rule.workspaceName ?? "",
    rule.isActive ? "active" : "inactive",
    `channels: ${channels.length === 0 ? "none" : channels.join(",")}`,
    `projects: ${projects}`,
  ]
    .filter((part) => part !== "")
    .join("  ");
};

// The global switches, each a flag of the same name. A bool flag sends only
// when it was passed, so `--email=false` turns email off and leaving it out
// leaves it as it is.
const SWITCHES = [
  ["email", "emailEnabled", "email delivery"],
  ["ntfy", "ntfyEnabled", "ntfy delivery"],
  ["gotify", "gotifyEnabled", "gotify delivery"],
  ["webhook", "webhookEnabled", "webhook delivery"],
  ["task-assignment", "taskAssignmentEnabled", "notify when a task is assigned"],
  ["task-comment", "taskCommentEnabled", "notify when a task is commented on"],
  ["task-status-change", "taskStatusChangeEnabled", "notify when a task changes status"],
  ["due-date-reminder", "dueDateReminderEnabled", "remind before a due date"],
] as const;

// The delivery settings that take text. Only a secret can be cleared: the
// server keeps the stored address when it is sent null (v2.29.2 reads it as
// `input ?? existing`), so an empty address is refused here rather than
// reported as done.
const CLEARABLE = new Set(["ntfy-token", "gotify-token", "webhook-secret"]);
const SETTINGS = [
  ["ntfy-server", "ntfyServerUrl", "ntfy server URL"],
  ["ntfy-topic", "ntfyTopic", "ntfy topic"],
  ["ntfy-token", "ntfyToken", "ntfy access token"],
  ["gotify-server", "gotifyServerUrl", "gotify server URL"],
  ["gotify-token", "gotifyToken", "gotify application token"],
  ["webhook-url", "webhookUrl", "webhook URL"],
  ["webhook-secret", "webhookSecret", "webhook signing secret"],
] as const;

const preferenceChanges = (flags: FlagValues, changed: ReadonlySet<string>): NotificationPreferenceChanges => {
  const changes: NotificationPreferenceChanges = {};
  for (const [flag, field] of SWITCHES) if (changed.has(flag)) changes[field] = flags[flag] === true;
  for (const [flag, field] of SETTINGS) {
    if (!changed.has(flag)) continue;
    const value = String(flags[flag] ?? "");
    if (value === "" && !CLEARABLE.has(flag)) throw new Error(`--${flag} cannot be cleared; the server keeps the stored value`);
    changes[field] = value === "" ? null : value;
  }
  if (changed.has("reminder-lead")) {
    const minutes = Number(flags["reminder-lead"]) / 60_000;
    // The server stores whole minutes; rounding would set a lead nobody asked for.
    if (!Number.isInteger(minutes)) throw new Error(`--reminder-lead must be a whole number of minutes`);
    changes.dueDateReminderLeadTimeMinutes = minutes;
  }
  return changes;
};

const RULE_SWITCHES = [
  ["active", "isActive", "notify for this workspace at all"],
  ["email", "emailEnabled", "email delivery"],
  ["ntfy", "ntfyEnabled", "ntfy delivery"],
  ["gotify", "gotifyEnabled", "gotify delivery"],
  ["webhook", "webhookEnabled", "webhook delivery"],
] as const;

// The server replaces a rule whole, so a flag left out would otherwise reset
// that field. The rule is built from the workspace's own rule, with only the
// flags passed changed on top; it is read and written in two requests, so a
// change made elsewhere in between is overwritten.
//
// A workspace without a rule gets nothing outside the app (v2.29.2 delivers
// only under an active rule, whatever the document says), so creating one is
// how delivery is turned on there: it starts active, with the channels that
// can deliver globally.
const ruleFor = (
  prefs: NotificationPreferences,
  workspaceId: string,
  flags: FlagValues,
  changed: ReadonlySet<string>,
): WorkspaceRule => {
  const current = (prefs.workspaces ?? []).find((rule) => rule.workspaceId === workspaceId);
  // The server refuses a channel that cannot deliver globally, and an inactive
  // rule keeps a channel that has since been switched off globally, so a channel
  // not passed as a flag is kept only where it can still deliver.
  const can = {
    emailEnabled: prefs.emailEnabled && !!prefs.emailAddress,
    ntfyEnabled: prefs.ntfyEnabled && prefs.ntfyConfigured,
    gotifyEnabled: prefs.gotifyEnabled && prefs.gotifyConfigured,
    webhookEnabled: prefs.webhookEnabled && prefs.webhookConfigured,
  };
  const rule: WorkspaceRule = current
    ? {
        isActive: current.isActive,
        emailEnabled: current.emailEnabled && can.emailEnabled,
        ntfyEnabled: current.ntfyEnabled && can.ntfyEnabled,
        gotifyEnabled: current.gotifyEnabled && can.gotifyEnabled,
        webhookEnabled: current.webhookEnabled && can.webhookEnabled,
        projectMode: current.projectMode,
        selectedProjectIds: current.selectedProjectIds ?? [],
      }
    : { isActive: true, ...can, projectMode: "all", selectedProjectIds: [] };
  for (const [flag, field] of RULE_SWITCHES) if (changed.has(flag)) rule[field] = flags[flag] === true;
  if (changed.has("projects")) {
    const ids = String(flags.projects ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    rule.projectMode = ids.length === 0 ? "all" : "selected";
    rule.selectedProjectIds = ids;
  }
  return rule;
};

const nothingToChange = (changed: ReadonlySet<string>, names: readonly string[]): void => {
  if (!names.some((name) => changed.has(name))) {
    throw new Error(`nothing to change: pass at least one of ${names.map((n) => `--${n}`).join(", ")}`);
  }
};

const boolFlag = (name: string, usage: string) => ({ name, type: "bool" as const, usage, defaultValue: "false" });
const stringFlag = (name: string, usage: string) => ({ name, type: "string" as const, usage, defaultValue: "" });

const preferencesCommand = {
  name: "preferences",
  aliases: ["prefs"],
  short: "Work with how notifications are delivered",
  children: [
    {
      name: "get",
      short: "Show the delivery settings and each workspace's rule",
      args: noArgs("kaneo notification preferences get"),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const prefs = await getNotificationPreferences();
        for (const line of preferenceLines(prefs)) app.out.human(line);
        app.out.data(prefs as Json);
      },
    },
    {
      name: "set",
      short: "Change the global delivery settings; only what is passed changes",
      long:
        "Change the global delivery settings; only what is passed changes.\n\n" +
        "A switch is turned off with =false (--email=false). An empty value clears a\n" +
        "token or secret (--webhook-secret ''). The server refuses that while the channel\n" +
        "lacks its URL (or ntfy topic), and always for the gotify token. A server URL or\n" +
        "topic cannot be cleared. A token or secret given as a flag is visible in the\n" +
        "process list.\n\n" +
        "The server carries a channel switch into the active workspace rules that have\n" +
        "a channel on: a channel turned off is turned off there, and one turned on from\n" +
        "off is turned on there. Inactive rules keep their channels.",
      args: noArgs("kaneo notification preferences set"),
      flags: [
        ...SWITCHES.map(([flag, , usage]) => boolFlag(flag, usage)),
        ...SETTINGS.map(([flag, , usage]) => stringFlag(flag, usage)),
        {
          name: "reminder-lead",
          type: "duration" as const,
          usage: "how long before a due date the reminder fires, 5m to 720h",
          defaultValue: "0s",
        },
      ],
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        nothingToChange(changed, [...SWITCHES.map(([f]) => f), ...SETTINGS.map(([f]) => f), "reminder-lead"]);
        const prefs = await updateNotificationPreferences(preferenceChanges(flags, changed));
        for (const line of preferenceLines(prefs)) app.out.human(line);
        app.out.data(prefs as Json);
      },
    },
    {
      name: "workspace",
      aliases: ["ws"],
      short: "Override the global settings for one workspace",
      children: [
        {
          name: "set",
          use: "set <workspace-id>",
          short: "Create or change a workspace's rule; only what is passed changes",
          long:
            "Create or change a workspace's rule; only what is passed changes.\n\n" +
            "A workspace without a rule is sent nothing outside the app, so setting one turns\n" +
            "delivery on for it: the new rule is active and starts from the channels that can\n" +
            "deliver globally, which may be none. A channel must be on and set up globally to\n" +
            "be turned on here, and a channel that can no longer deliver is dropped from the\n" +
            "rule. A rule with no channel on is not reached when a channel is later turned on\n" +
            "globally.\n" +
            "--projects takes comma-separated project ids; an empty value means every project.",
          args: exactArgs(1),
          flags: [
            ...RULE_SWITCHES.map(([flag, , usage]) => boolFlag(flag, usage)),
            stringFlag("projects", "only these projects, comma-separated ids"),
          ],
          run: async ({ args, flags, changed, app }: RunContext<App>) => {
            apiKey(app);
            const workspaceId = args[0]!;
            nothingToChange(changed, [...RULE_SWITCHES.map(([f]) => f), "projects"]);
            const before = await getNotificationPreferences();
            const prefs = await setWorkspaceRule(workspaceId, ruleFor(before, workspaceId, flags, changed));
            const rule = (prefs.workspaces ?? []).find((r) => r.workspaceId === workspaceId);
            if (rule === undefined) {
              throw new Error(`the server accepted the rule but does not list one for workspace ${JSON.stringify(workspaceId)}`);
            }
            app.out.human(ruleLine(rule));
            app.out.data(rule as Json);
          },
        },
        {
          name: "rm",
          aliases: ["delete"],
          use: "rm <workspace-id>",
          short: "Remove a workspace's rule; it is then sent nothing outside the app",
          args: exactArgs(1),
          run: async ({ args, app }: RunContext<App>) => {
            apiKey(app);
            const workspaceId = args[0]!;
            await removeWorkspaceRule(workspaceId);
            app.out.human(`removed the rule for ${workspaceId}; it is sent nothing outside the app until a rule is set`);
            app.out.data({ workspaceId });
          },
        },
      ],
    },
  ],
};

export const notificationCommand = {
  name: "notification",
  aliases: ["notif"],
  short: "Work with your notifications",
  children: [
    {
      name: "list",
      aliases: ["ls"],
      short: "List your notifications",
      args: noArgs("kaneo notification list"),
      long:
        "List your notifications.\n\n" +
        "The server answers with the newest 50 only, so an unread notification older\n" +
        "than those is not listed, --unread included.",
      flags: [boolFlag("unread", "only unread notifications")],
      run: async ({ flags, app }: RunContext<App>) => {
        apiKey(app);
        const all = await listNotifications();
        const shown = flags.unread === true ? all.filter((n) => !n.isRead) : all;
        for (const n of shown) app.out.human(notificationLine(n));
        app.out.data(shown as Json);
      },
    },
    {
      name: "read",
      use: "read <notification-id>... | --all",
      short: "Mark notifications as read",
      flags: [boolFlag("all", "mark every notification as read")],
      run: async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        if (flags.all === true) {
          if (args.length > 0) throw new Error("pass notification ids or --all, not both");
          await markAllNotificationsRead();
          app.out.human("marked every notification read");
          app.out.data({ all: true });
          return;
        }
        if (args.length === 0) throw new Error("pass notification ids, or --all");
        const read: Notification[] = [];
        for (const id of args) {
          try {
            read.push(await markNotificationRead(id));
          } catch (e) {
            // The ones before it are read on the server already, which a caller
            // reading only the failure would otherwise not know.
            if (read.length === 0) throw e;
            throw new Error(`${(e as Error).message} (already marked read: ${read.map((n) => n.id).join(", ")})`);
          }
        }
        for (const n of read) app.out.human(`read ${n.id}`);
        app.out.data(read as Json);
      },
    },
    {
      name: "clear",
      short: "Delete every notification",
      args: noArgs("kaneo notification clear"),
      flags: [boolFlag("yes", "confirm the deletion")],
      run: async ({ flags, app }: RunContext<App>) => {
        apiKey(app);
        // The server deletes them all at once and keeps nothing to undo it with.
        if (flags.yes !== true) throw new Error("refusing to delete every notification without --yes; this cannot be undone");
        await clearNotifications();
        app.out.human("cleared every notification");
        app.out.data({ cleared: true });
      },
    },
    {
      name: "create",
      use: "create <message>",
      short: "Send yourself a notification",
      long:
        "Send yourself a notification.\n\n" +
        "Several words are one message. The server stores nothing when the type is\n" +
        "turned off in your preferences, or when the task or workspace it points at is\n" +
        "not one you can reach; that is reported, and is not a failure. One that points\n" +
        "at a task or workspace is also delivered through the channels its workspace\n" +
        "rule has on, when that rule is active and covers the project; a rule limited to\n" +
        "some projects is never sent one that points at a workspace.",
      args: minimumArgs(1),
      flags: [
        { name: "type", type: "string" as const, usage: "notification type", defaultValue: "info" },
        stringFlag("title", "title"),
        stringFlag("resource-type", "what it points at: task or workspace"),
        stringFlag("resource-id", "the id of the task or workspace it points at"),
      ],
      run: async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        const resourceType = String(flags["resource-type"] ?? "");
        const resourceId = String(flags["resource-id"] ?? "");
        if (resourceType !== "" && resourceType !== "task" && resourceType !== "workspace") {
          throw new Error(`--resource-type must be task or workspace, not ${JSON.stringify(resourceType)}`);
        }
        if ((resourceType === "") !== (resourceId === "")) {
          throw new Error("--resource-type and --resource-id go together");
        }
        const created = await createNotification({
          type: String(flags.type ?? ""),
          title: String(flags.title ?? ""),
          message: args.join(" "),
          resourceType,
          resourceId,
        });
        app.out.human(
          created === null
            ? "not stored: the type is turned off, or what it points at is not reachable"
            : `created ${created.id}`,
        );
        app.out.data(created as Json);
      },
    },
    preferencesCommand,
  ],
};
