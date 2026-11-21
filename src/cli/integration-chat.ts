import { apiKey, project, type App } from "./app";
import {
  getProject,
  type IntegrationEventChanges,
  type IntegrationEvents,
  type NewWebhookIntegration,
  type WebhookIntegration,
  type WebhookIntegrationChanges,
} from "../api/kaneo";
import { noArgs, type Command, type Flag, type FlagValues, type RunContext } from "./args";
import { readInput } from "./input";
import { withProject } from "./lookup";
import type { Json } from "../output/json";

// The machinery the chat integration providers — slack, discord and telegram,
// one command node each in integration-<provider>.ts — share: the event
// toggles every provider's `events` object carries, the stdin-only reading of
// their secrets, and the `get|set|rm` command shape the other external
// integrations use, where `set` posts a new integration when the project has
// none and patches only the fields passed when it does.

export const EVENT_FLAGS: Flag[] = [
  { name: "task-created", type: "bool", usage: "notify when a task is created", defaultValue: "false" },
  { name: "task-status-changed", type: "bool", usage: "notify when a task changes status", defaultValue: "false" },
  {
    name: "task-priority-changed",
    type: "bool",
    usage: "notify when a task's priority changes",
    defaultValue: "false",
  },
  { name: "task-title-changed", type: "bool", usage: "notify when a task is renamed", defaultValue: "false" },
  {
    name: "task-description-changed",
    type: "bool",
    usage: "notify when a task's description changes",
    defaultValue: "false",
  },
  { name: "task-comment-created", type: "bool", usage: "notify when a task gets a comment", defaultValue: "false" },
];

const EVENT_FIELDS = [
  ["task-created", "taskCreated"],
  ["task-status-changed", "taskStatusChanged"],
  ["task-priority-changed", "taskPriorityChanged"],
  ["task-title-changed", "taskTitleChanged"],
  ["task-description-changed", "taskDescriptionChanged"],
  ["task-comment-created", "taskCommentCreated"],
] as const;

const EVENT_LABELS = [
  ["taskCreated", "task created"],
  ["taskStatusChanged", "task status changed"],
  ["taskPriorityChanged", "task priority changed"],
  ["taskTitleChanged", "task title changed"],
  ["taskDescriptionChanged", "task description changed"],
  ["taskCommentCreated", "task comment created"],
] as const;

// Only the toggles passed are sent; the server merges them into the stored
// set rather than replacing it.
export const eventChanges = (flags: FlagValues, changed: ReadonlySet<string>): IntegrationEventChanges | undefined => {
  const events: IntegrationEventChanges = {};
  let any = false;
  for (const [flag, field] of EVENT_FIELDS) {
    if (changed.has(flag)) {
      events[field] = flags[flag] === true;
      any = true;
    }
  }
  return any ? events : undefined;
};

export const eventSummary = (events: IntegrationEvents): string => {
  const on = EVENT_LABELS.filter(([field]) => events[field]).map(([, label]) => label);
  return on.length === 0 ? "none" : on.join(", ");
};

export const ACTIVE_FLAG: Flag = {
  name: "active",
  type: "bool",
  usage: "send events; a new integration is created active",
  defaultValue: "false",
};

// isActive is null on a row the server never set it on, which reads as unset
// rather than as on or off.
export const activeLabel = (isActive: boolean | null): string =>
  isActive === null ? "unset" : isActive ? "on" : "off";

// A webhook URL or bot token on the command line is visible in the process
// list and the shell history, so the flag takes only `-`, which reads the
// secret from stdin. Notification secrets still take a literal value; these
// providers are deliberately stricter — stdin is the only spelling, so a
// secret cannot land on a command line by accident. Each provider has exactly
// one secret flag, so two can never ask for the one stdin stream at once.
const stdinSecret = async (flag: string, flags: FlagValues): Promise<string> => {
  if (String(flags[flag] ?? "") !== "-") {
    throw new Error(
      `--${flag} is a secret and takes - only: pipe the value on stdin rather than passing it on the command line`,
    );
  }
  const text = (await readInput("-")).replace(/\r?\n$/, "");
  // Whitespace alone is no credential: a webhook URL of spaces trims to the
  // stored one on update and a bot token of them fails the server's shape
  // check, so it is refused here rather than sent.
  if (text.trim() === "") throw new Error(`empty --${flag} on stdin`);
  return text;
};

// A provider's stdin secret as `set` resolved it: the flag that carries it,
// the noun a create error calls it, and the value read before the existence
// check — undefined when the flag was not passed.
export type ChatSecret = { flag: string; what: string; value: string | undefined };

// The secret a create cannot do without.
export const requiredSecret = (secret: ChatSecret): string => {
  if (secret.value === undefined) {
    throw new Error(
      `creating an integration needs --${secret.flag} -: the ${secret.what} is read from stdin so it never appears on the command line`,
    );
  }
  return secret.value;
};

// A plain value a create cannot do without.
export const requiredText = (flag: string, what: string, flags: FlagValues, changed: ReadonlySet<string>): string => {
  if (!changed.has(flag)) throw new Error(`creating an integration needs --${flag}: the ${what} is required`);
  return requiredTextValue(flags, flag);
};

// chatId is required on create and optional on update, but never empty.
export const requiredTextValue = (flags: FlagValues, flag: string): string => {
  const value = String(flags[flag] ?? "").trim();
  if (value === "") throw new Error(`--${flag} is empty`);
  return value;
};

// '' leaves the field unset on create; on update it clears it (null).
export const optionalText = (flags: FlagValues, flag: string): string | undefined => {
  const value = String(flags[flag] ?? "");
  return value === "" ? undefined : value;
};

export const nullableText = (flags: FlagValues, flag: string): string | null => {
  const value = String(flags[flag] ?? "");
  return value === "" ? null : value;
};

type ChatApi<T, C, U> = {
  get(projectId: string): Promise<T | null>;
  create(projectId: string, body: C): Promise<T | null>;
  update(projectId: string, body: U): Promise<T | null>;
  remove(projectId: string): Promise<{ success: boolean }>;
};

export type ChatSpec<T extends Json, C extends object, U extends object> = {
  name: string;
  flags: Flag[];
  setLong: string;
  api: ChatApi<T, C, U>;
  // The flag whose secret is piped on stdin, with the noun the create error
  // calls it. Exactly one per provider — stdin is a single stream.
  secret: { flag: string; what: string };
  createBody: (flags: FlagValues, changed: ReadonlySet<string>, secret: ChatSecret) => C | Promise<C>;
  updateBody: (flags: FlagValues, changed: ReadonlySet<string>, secret: ChatSecret) => U | Promise<U>;
  describe: (integration: T) => string[];
  // Flags the create body cannot carry, with the reason each is refused on
  // the create path: --active is the one every provider here shares, since a
  // new integration is always created active.
  createRefuses?: Record<string, string>;
};

export const chatProvider = <T extends Json, C extends object, U extends object>(
  spec: ChatSpec<T, C, U>,
): Command<App> => ({
  name: spec.name,
  short: `Show, set or remove the project's ${spec.name} integration`,
  children: [
    {
      name: "get",
      short: `Show the ${spec.name} integration`,
      args: noArgs(`kaneo integration ${spec.name} get`),
      run: async ({ app }: RunContext<App>) => {
        apiKey(app);
        const found = await withProject(project(app), (id) => spec.api.get(id));
        if (found === null) {
          app.out.human(`no ${spec.name} integration on this project`);
          app.out.data(null);
          return;
        }
        for (const line of spec.describe(found)) app.out.human(line);
        app.out.data(found);
      },
    },
    {
      name: "set",
      short: `Create or change the ${spec.name} integration; only what is passed changes`,
      long: spec.setLong,
      args: noArgs(`kaneo integration ${spec.name} set`),
      flags: spec.flags,
      run: async ({ flags, changed, app }: RunContext<App>) => {
        apiKey(app);
        // The secret is read before the lookup's first request rather than
        // between the existence GET and the write: the wait for piped stdin
        // would otherwise stretch the window in which a concurrent `set`
        // could create the integration first, and this run's POST would then
        // replace it — the server's create is "create or replace" and has no
        // conditional create to lose to. Reading first leaves only the
        // requests themselves in the window; it cannot close it.
        const secret: ChatSecret = {
          ...spec.secret,
          value: changed.has(spec.secret.flag) ? await stdinSecret(spec.secret.flag, flags) : undefined,
        };
        // The whole read-then-write goes through the lookup: -p takes a slug
        // or a name like every other project command, and only the read —
        // the first request, the one withProject needs to carry the project —
        // can tell a create from an update.
        const done = await withProject(project(app), async (id) => {
          const existing = await spec.api.get(id);
          if (existing === null) {
            for (const [flag, reason] of Object.entries(spec.createRefuses ?? {})) {
              if (changed.has(flag)) throw new Error(`--${flag} ${reason}`);
            }
            const created = await spec.api.create(id, await spec.createBody(flags, changed, secret));
            if (created === null) throw new Error(`the server accepted the ${spec.name} integration but returned none`);
            return { created: true, integration: created };
          }
          const changes = await spec.updateBody(flags, changed, secret);
          if (Object.keys(changes).length === 0) {
            throw new Error(
              `nothing to change: pass at least one of ${spec.flags.map((f) => `--${f.name}`).join(", ")}`,
            );
          }
          const updated = await spec.api.update(id, changes);
          if (updated === null)
            throw new Error(`the server accepted the change but returned no ${spec.name} integration`);
          return { created: false, integration: updated };
        });
        app.out.human(`${done.created ? "created" : "updated"} ${spec.name} integration`);
        for (const line of spec.describe(done.integration)) app.out.human(line);
        app.out.data(done.integration);
      },
    },
    {
      name: "rm",
      aliases: ["delete"],
      short: `Remove the ${spec.name} integration`,
      args: noArgs(`kaneo integration ${spec.name} rm`),
      flags: [{ name: "yes", type: "bool", usage: "confirm the removal", defaultValue: "false" }],
      run: async ({ flags, app }: RunContext<App>) => {
        apiKey(app);
        const result = await withProject(project(app), async (id) => {
          const found = await spec.api.get(id);
          if (found === null) throw new Error(`no ${spec.name} integration on this project`);
          // The webhook URL or bot token and the event settings go with it.
          if (flags.yes !== true) {
            const p = await getProject(id);
            throw new Error(
              `refusing to remove the ${spec.name} integration on ${p.name}${p.slug === "" ? "" : ` [${p.slug}]`} (${p.id}) without --yes`,
            );
          }
          return spec.api.remove(id);
        });
        app.out.human(`removed the ${spec.name} integration`);
        app.out.data(result);
      },
    },
  ],
});

const webhookCreateBody = (
  flags: FlagValues,
  changed: ReadonlySet<string>,
  secret: ChatSecret,
): NewWebhookIntegration => {
  const wanted: NewWebhookIntegration = { webhookUrl: requiredSecret(secret) };
  const channel = optionalText(flags, "channel-name");
  if (changed.has("channel-name") && channel !== undefined) wanted.channelName = channel;
  const events = eventChanges(flags, changed);
  if (events !== undefined) wanted.events = events;
  return wanted;
};

const webhookUpdateBody = (
  flags: FlagValues,
  changed: ReadonlySet<string>,
  secret: ChatSecret,
): WebhookIntegrationChanges => {
  const changes: WebhookIntegrationChanges = {};
  if (secret.value !== undefined) changes.webhookUrl = secret.value;
  if (changed.has("channel-name")) changes.channelName = nullableText(flags, "channel-name");
  if (changed.has("active")) changes.isActive = flags.active === true;
  const events = eventChanges(flags, changed);
  if (events !== undefined) changes.events = events;
  return changes;
};

const webhookFlags = (name: string): Flag[] => [
  { name: "webhook-url", type: "string", usage: `${name} webhook URL; - reads it from stdin`, defaultValue: "" },
  { name: "channel-name", type: "string", usage: "channel to post to; '' clears it", defaultValue: "" },
  ACTIVE_FLAG,
  ...EVENT_FLAGS,
];

const webhookSetLong = (title: string): string =>
  `Create or change the ${title} integration for the project.\n\n` +
  "With no integration on the project this posts a new one; the webhook URL\n" +
  "is required then. The URL is a secret, so it is never taken as a flag\n" +
  "value: pass - and pipe it on stdin instead, since a value on the command\n" +
  "line shows in the process list and the shell history. With an integration\n" +
  "already there only the fields passed change: --channel-name '' clears the\n" +
  "channel and --active=false stops delivery without removing it. Event\n" +
  "toggles merge into the stored set.";

const webhookDescribe = (i: WebhookIntegration): string[] => [
  `id         ${i.id}`,
  `project    ${i.projectId}`,
  `channel    ${i.channelName ?? "-"}`,
  `webhook    ${i.webhookConfigured && i.maskedWebhookUrl !== "" ? i.maskedWebhookUrl : "not set"}`,
  `events     ${eventSummary(i.events)}`,
  `active     ${activeLabel(i.isActive)}`,
  `created    ${i.createdAt}`,
  `updated    ${i.updatedAt}`,
];

// The spec both webhook chat providers share: slack and discord differ only in
// the name they go by and the routes their secrets are checked against.
export const webhookSpec = (
  name: string,
  title: string,
  api: ChatApi<WebhookIntegration, NewWebhookIntegration, WebhookIntegrationChanges>,
): ChatSpec<WebhookIntegration, NewWebhookIntegration, WebhookIntegrationChanges> => ({
  name,
  flags: webhookFlags(title),
  setLong: webhookSetLong(title),
  api,
  secret: { flag: "webhook-url", what: "webhook URL" },
  createBody: webhookCreateBody,
  updateBody: webhookUpdateBody,
  describe: webhookDescribe,
  createRefuses: { active: "does not apply to a new integration; it is created active" },
});
