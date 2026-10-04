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
// it came from, so the type is always shown and the text only when there is one.
const notificationLine = (n: Notification): string =>
  [n.id, n.createdAt, n.isRead ? "read  " : "unread", n.type, [n.title, n.content].filter((t) => t).join(": ")]
    .join("  ")
    .trimEnd();

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

// The delivery settings that take text. An empty value clears the setting,
// which for a token or secret is the only way to remove it.
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
// that field. The rule is built from what the workspace gets today — its own
// rule, or the global channels it falls back to — with only the flags passed
// changed on top.
const ruleFor = (
  prefs: NotificationPreferences,
  workspaceId: string,
  flags: FlagValues,
  changed: ReadonlySet<string>,
): WorkspaceRule => {
  const current = (prefs.workspaces ?? []).find((rule) => rule.workspaceId === workspaceId);
  const rule: WorkspaceRule = current
    ? {
        isActive: current.isActive,
        emailEnabled: current.emailEnabled,
        ntfyEnabled: current.ntfyEnabled,
        gotifyEnabled: current.gotifyEnabled,
        webhookEnabled: current.webhookEnabled,
        projectMode: current.projectMode,
        selectedProjectIds: current.selectedProjectIds,
      }
    : {
        isActive: true,
        emailEnabled: prefs.emailEnabled,
        ntfyEnabled: prefs.ntfyEnabled,
        gotifyEnabled: prefs.gotifyEnabled,
        webhookEnabled: prefs.webhookEnabled,
        projectMode: "all",
        selectedProjectIds: [],
      };
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
        "setting (--webhook-secret ''). A token or secret given as a flag is visible in\n" +
        "the process list.",
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
            "A workspace without a rule starts from the global channels. --projects takes\n" +
            "comma-separated project ids; an empty value means every project.",
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
          short: "Remove a workspace's rule so it follows the global settings",
          args: exactArgs(1),
          run: async ({ args, app }: RunContext<App>) => {
            apiKey(app);
            const workspaceId = args[0]!;
            await removeWorkspaceRule(workspaceId);
            app.out.human(`removed the rule for ${workspaceId}; it follows the global settings`);
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
          const n = await markNotificationRead(id);
          app.out.human(`read ${n.id}`);
          read.push(n);
        }
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
        "turned off in your preferences; that is reported, and is not a failure.",
      args: minimumArgs(1),
      flags: [
        { name: "type", type: "string" as const, usage: "notification type", defaultValue: "info" },
        stringFlag("title", "title"),
        stringFlag("resource-type", "what it points at: task or workspace"),
        stringFlag("resource-id", "the id of the task or workspace it points at"),
      ],
      run: async ({ args, flags, app }: RunContext<App>) => {
        apiKey(app);
        const created = await createNotification({
          type: String(flags.type ?? ""),
          title: String(flags.title ?? ""),
          message: args.join(" "),
          resourceType: String(flags["resource-type"] ?? ""),
          resourceId: String(flags["resource-id"] ?? ""),
        });
        app.out.human(created === null ? "not stored: this notification type is turned off" : `created ${created.id}`);
        app.out.data(created as Json);
      },
    },
    preferencesCommand,
  ],
};
