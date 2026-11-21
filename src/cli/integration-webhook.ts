import {
  createGenericWebhookIntegration,
  deleteGenericWebhookIntegration,
  getGenericWebhookIntegration,
  updateGenericWebhookIntegration,
  type GenericWebhookIntegration,
  type GenericWebhookIntegrationChanges,
  type NewGenericWebhookIntegration,
} from "../api/kaneo";
import type { FlagValues } from "./args";
import {
  activeLabel,
  ALL_EVENTS,
  boolFlag,
  eventSummary,
  eventToggles,
  providerCommand,
  requireCreateWebhookUrl,
  secretFlag,
  stringFlag,
  WEBHOOK_URL_FLAG,
  webhookUrlFlag,
  type IntegrationSpec,
} from "./integration-shared";

// The generic webhook integration POSTs task events to any HTTP endpoint,
// signed with an HMAC secret when one is set. Both the URL and the secret are
// credentials, so `set` has two stdin flags and only one of them can read the
// one stdin stream at a time; each also has a `-file` sibling, which is how a
// create can carry both in a single command.

// How long before a due date the reminder fires, in the whole minutes the API
// stores. The flag is a duration, and a fraction of a minute would be rounded
// into a lead nobody asked for; the document's bounds are 5 minutes to 30 days.
const reminderLead = (flags: FlagValues): number => {
  const minutes = Number(flags["reminder-lead"]) / 60_000;
  if (!Number.isInteger(minutes)) throw new Error("--reminder-lead must be a whole number of minutes");
  if (minutes < 5 || minutes > 43_200) throw new Error("--reminder-lead must be between 5 minutes and 30 days");
  return minutes;
};

export const webhookCreateBody = (
  flags: FlagValues,
  changed: ReadonlySet<string>,
): NewGenericWebhookIntegration => {
  const wanted: NewGenericWebhookIntegration = { webhookUrl: webhookUrlFlag(flags, changed, true) };
  const signingSecret = secretFlag("secret", flags, changed, true);
  if (signingSecret !== undefined && signingSecret !== null) wanted.secret = signingSecret;
  const events = eventToggles(flags, changed, ALL_EVENTS);
  if (Object.keys(events).length > 0) wanted.events = events;
  if (changed.has("reminder-lead")) wanted.dueDateReminderLeadTimeMinutes = reminderLead(flags);
  return wanted;
};

export const webhookUpdateBody = (
  flags: FlagValues,
  changed: ReadonlySet<string>,
): GenericWebhookIntegrationChanges => {
  const changes: GenericWebhookIntegrationChanges = {};
  const url = webhookUrlFlag(flags, changed, false);
  if (url !== undefined) changes.webhookUrl = url;
  const signingSecret = secretFlag("secret", flags, changed, false);
  if (signingSecret !== undefined) changes.secret = signingSecret;
  if (changed.has("active")) changes.isActive = flags.active === true;
  const events = eventToggles(flags, changed, ALL_EVENTS);
  if (Object.keys(events).length > 0) changes.events = events;
  if (changed.has("reminder-lead")) changes.dueDateReminderLeadTimeMinutes = reminderLead(flags);
  return changes;
};

// The reminder lead in the units the flag takes, so 1440 stored minutes read
// as the day it is rather than a number to divide.
const reminderLabel = (minutes: number): string => {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
};

// The credential flags as they are typed, for the help that names them.
const URL_T = "--" + WEBHOOK_URL_FLAG;
const SEC_T = "--" + "secret";

const WEBHOOK: IntegrationSpec<GenericWebhookIntegration, NewGenericWebhookIntegration, GenericWebhookIntegrationChanges> = {
  name: "webhook",
  short: "Outgoing webhook integration for a project",
  long: "Task events POSTed to an HTTP endpoint, signed with an HMAC secret when one is set.\n\nThe URL and the secret are credentials: the server returns only masked forms of them.",
  setShort: "Create or change the project's outgoing webhook integration",
  setLong:
    "Create the project's outgoing webhook when it has none, or change the one\n" +
    "it has; only the flags passed are sent, so the rest keep their values. The\n" +
    "create is the API's create-or-replace: a row another writer adds between\n" +
    "the read and the POST is replaced rather than refused.\n\n" +
    `Creating needs ${URL_T} - or ${URL_T}-file <path>; --active does not apply to a\n` +
    "new integration, which is created active. On an existing integration\n" +
    `${URL_T} cannot be emptied, ${SEC_T} '' clears the signing secret, and\n` +
    "each event flag merges into the stored toggles. --reminder-lead is how long\n" +
    "before a due date the due-date-reminder event fires, 5m to 720h (the API's\n" +
    "5 minutes to 30 days).\n\n" +
    `The webhook URL and the secret are credentials: ${URL_T} - and ${SEC_T} - read\n` +
    `them from stdin, ${URL_T}-file and ${SEC_T}-file read them from a file\n` +
    "(- reads stdin there too), one stdin reader per command; the one line\n" +
    "ending a pipe or file adds is not part of the value.",
  flags: [
    stringFlag(WEBHOOK_URL_FLAG, `the endpoint task events are POSTed to; - reads it from stdin, ${URL_T}-file reads it from a file`),
    stringFlag(`${WEBHOOK_URL_FLAG}-file`, "read the endpoint from a file; - reads stdin"),
    stringFlag("secret", `the HMAC signing secret; - reads it from stdin, ${SEC_T}-file reads it from a file; '' clears it`),
    stringFlag("secret-file", "read the signing secret from a file; - reads stdin"),
    boolFlag("active", "deliver events; =false pauses delivery"),
    {
      name: "reminder-lead",
      type: "duration" as const,
      usage: "how long before a due date the reminder fires, 5m to 720h",
      defaultValue: "0s",
    },
    ...ALL_EVENTS.map(([flag, , usage]) => boolFlag(flag, usage)),
  ],
  stdin: [WEBHOOK_URL_FLAG, "secret"],
  files: [WEBHOOK_URL_FLAG, "secret"],
  validateCreate: requireCreateWebhookUrl,
  api: {
    get: getGenericWebhookIntegration,
    create: createGenericWebhookIntegration,
    update: updateGenericWebhookIntegration,
    remove: deleteGenericWebhookIntegration,
  },
  createBody: webhookCreateBody,
  updateBody: webhookUpdateBody,
  describe: (i) => {
    const {
      webhookConfigured,
      maskedWebhookUrl,
      secretConfigured,
      maskedSecret,
      events,
      dueDateReminderLeadTimeMinutes,
      isActive,
      id,
      projectId,
      createdAt,
      updatedAt,
    } = i;
    return [
      `id         ${id}`,
      `project    ${projectId}`,
      `webhook    ${webhookConfigured ? maskedWebhookUrl ?? "(hidden)" : "not set"}`,
      `secret     ${secretConfigured ? maskedSecret ?? "(hidden)" : "not set"}`,
      `events     ${eventSummary(events, ALL_EVENTS)}`,
      `reminder   ${reminderLabel(dueDateReminderLeadTimeMinutes)} before a due date`,
      `active     ${activeLabel(isActive)}`,
      `created    ${createdAt}`,
      `updated    ${updatedAt}`,
    ];
  },
  createRefuses: { active: "does not apply to a new integration; it is created active" },
};

export const webhookCommand = providerCommand(WEBHOOK);
