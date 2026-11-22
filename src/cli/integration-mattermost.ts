import {
  createMattermostIntegration,
  deleteMattermostIntegration,
  getMattermostIntegration,
  updateMattermostIntegration,
  type MattermostIntegration,
  type MattermostIntegrationChanges,
  type NewMattermostIntegration,
} from "../api/kaneo";
import type { FlagValues } from "./args";
import {
  activeLabel,
  boolFlag,
  eventSummary,
  eventToggles,
  providerCommand,
  requireCreateWebhookUrl,
  SHARED_EVENTS,
  stringFlag,
  WEBHOOK_URL_FLAG,
  webhookUrlFlag,
  type IntegrationSpec,
} from "./integration-shared";

// The Mattermost integration posts task events to an incoming webhook. Its
// credential is the webhook URL alone, so `set` has exactly one stdin flag,
// with a `-file` sibling for the same value out of a file.

export const mattermostCreateBody = (flags: FlagValues, changed: ReadonlySet<string>): NewMattermostIntegration => {
  const wanted: NewMattermostIntegration = { webhookUrl: webhookUrlFlag(flags, changed, true) };
  const channelName = String(flags["channel-name"] ?? "");
  // An empty channel on create means none, which is what leaving it out says.
  if (changed.has("channel-name") && channelName !== "") wanted.channelName = channelName;
  const events = eventToggles(flags, changed, SHARED_EVENTS);
  if (Object.keys(events).length > 0) wanted.events = events;
  return wanted;
};

export const mattermostUpdateBody = (flags: FlagValues, changed: ReadonlySet<string>): MattermostIntegrationChanges => {
  const changes: MattermostIntegrationChanges = {};
  const url = webhookUrlFlag(flags, changed, false);
  if (url !== undefined) changes.webhookUrl = url;
  if (changed.has("channel-name")) {
    const channelName = String(flags["channel-name"] ?? "");
    // null is the update schema's way of clearing the channel.
    changes.channelName = channelName === "" ? null : channelName;
  }
  if (changed.has("active")) changes.isActive = flags.active === true;
  const events = eventToggles(flags, changed, SHARED_EVENTS);
  if (Object.keys(events).length > 0) changes.events = events;
  return changes;
};

// The webhook URL flag as it is typed, for the help that names it.
const URL_T = "--" + WEBHOOK_URL_FLAG;

const MATTERMOST: IntegrationSpec<MattermostIntegration, NewMattermostIntegration, MattermostIntegrationChanges> = {
  name: "mattermost",
  short: "Mattermost integration for a project",
  long: "Task events posted to a Mattermost incoming webhook.\n\nThe webhook URL is a credential: the server returns only a masked form of it.",
  setShort: "Create or change the project's Mattermost integration",
  setLong:
    "Create the project's Mattermost integration when it has none, or change the\n" +
    "one it has; only the flags passed are sent, so the rest keep their values. The\n" +
    "create is the API's create-or-replace: a row another writer adds between\n" +
    "the read and the POST is replaced rather than refused.\n\n" +
    `Creating needs ${URL_T} - (HTTPS) or ${URL_T}-file <path>; --active does not apply to a new\n` +
    "integration, which is created active. On an existing integration\n" +
    `${URL_T} cannot be emptied, --channel-name '' clears the channel, and\n` +
    "each event flag merges into the stored toggles.\n\n" +
    `The webhook URL is a credential: ${URL_T} - reads it from stdin, ${URL_T}-file\n` +
    "reads it from a file (- reads stdin there too), one stdin reader per\n" +
    "command; the one line ending a pipe or file adds is not part of the value.",
  flags: [
    stringFlag(
      WEBHOOK_URL_FLAG,
      `the Mattermost incoming webhook URL (HTTPS); - reads it from stdin, ${URL_T}-file reads it from a file`,
    ),
    stringFlag(`${WEBHOOK_URL_FLAG}-file`, "read the webhook URL from a file; - reads stdin"),
    stringFlag("channel-name", "the channel events are posted to; '' clears it"),
    boolFlag("active", "deliver events; =false pauses delivery"),
    ...SHARED_EVENTS.map(([flag, , usage]) => boolFlag(flag, usage)),
  ],
  stdin: [WEBHOOK_URL_FLAG],
  files: [WEBHOOK_URL_FLAG],
  validateCreate: requireCreateWebhookUrl,
  api: {
    get: getMattermostIntegration,
    create: createMattermostIntegration,
    update: updateMattermostIntegration,
    remove: deleteMattermostIntegration,
  },
  createBody: mattermostCreateBody,
  updateBody: mattermostUpdateBody,
  describe: (i) => {
    const { channelName, webhookConfigured, maskedWebhookUrl, events, isActive, id, projectId, createdAt, updatedAt } =
      i;
    return [
      `id         ${id}`,
      `project    ${projectId}`,
      `channel    ${channelName ?? "unset"}`,
      `webhook    ${webhookConfigured ? maskedWebhookUrl || "(hidden)" : "not set"}`,
      `events     ${eventSummary(events, SHARED_EVENTS)}`,
      `active     ${activeLabel(isActive)}`,
      `created    ${createdAt}`,
      `updated    ${updatedAt}`,
    ];
  },
  createRefuses: { active: "does not apply to a new integration; it is created active" },
};

export const mattermostCommand = providerCommand(MATTERMOST);
