import {
  createTelegramIntegration,
  deleteTelegramIntegration,
  getTelegramIntegration,
  updateTelegramIntegration,
  type NewTelegramIntegration,
  type TelegramIntegration,
  type TelegramIntegrationChanges,
} from "../api/kaneo";
import type { FlagValues } from "./args";
import {
  ACTIVE_FLAG,
  EVENT_FLAGS,
  activeLabel,
  chatProvider,
  eventChanges,
  eventSummary,
  nullableText,
  optionalText,
  requiredSecret,
  requiredText,
  requiredTextValue,
  type ChatSecret,
  type ChatSpec,
} from "./integration-chat";

// threadId is the one numeric field; '' clears it on update. Only a plain
// decimal spelling is taken: Number() would also read 0x10, 1e3 and
// whitespace as numbers the flag does not mean to send.
const threadId = (flags: FlagValues): number | null => {
  const value = String(flags["thread-id"] ?? "");
  if (value === "") return null;
  const id = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(id) || id < 1) throw new Error(`--thread-id must be a positive integer, not ${JSON.stringify(value)}`);
  return id;
};

const telegramCreateBody = (flags: FlagValues, changed: ReadonlySet<string>, secret: ChatSecret): NewTelegramIntegration => {
  const wanted: NewTelegramIntegration = {
    botToken: requiredSecret(secret),
    chatId: requiredText("chat-id", "chat id", flags, changed),
  };
  if (changed.has("thread-id")) {
    const thread = threadId(flags);
    if (thread !== null) wanted.threadId = thread;
  }
  const label = optionalText(flags, "chat-label");
  if (changed.has("chat-label") && label !== undefined) wanted.chatLabel = label;
  const events = eventChanges(flags, changed);
  if (events !== undefined) wanted.events = events;
  return wanted;
};

const telegramUpdateBody = (flags: FlagValues, changed: ReadonlySet<string>, secret: ChatSecret): TelegramIntegrationChanges => {
  const changes: TelegramIntegrationChanges = {};
  if (secret.value !== undefined) changes.botToken = secret.value;
  if (changed.has("chat-id")) changes.chatId = requiredTextValue(flags, "chat-id");
  if (changed.has("thread-id")) changes.threadId = threadId(flags);
  if (changed.has("chat-label")) changes.chatLabel = nullableText(flags, "chat-label");
  if (changed.has("active")) changes.isActive = flags.active === true;
  const events = eventChanges(flags, changed);
  if (events !== undefined) changes.events = events;
  return changes;
};

const telegramDescribe = (t: TelegramIntegration): string[] => [
  `id         ${t.id}`,
  `project    ${t.projectId}`,
  `chat       ${t.chatLabel ? `${t.chatLabel} (${t.chatId})` : t.chatId}`,
  `thread     ${t.threadId ?? "-"}`,
  `bot        ${t.botTokenConfigured && t.maskedBotToken !== "" ? t.maskedBotToken : "not set"}`,
  `events     ${eventSummary(t.events)}`,
  `active     ${activeLabel(t.isActive)}`,
  `created    ${t.createdAt}`,
  `updated    ${t.updatedAt}`,
];

const telegramSpec: ChatSpec<TelegramIntegration, NewTelegramIntegration, TelegramIntegrationChanges> = {
  name: "telegram",
  flags: [
    { name: "bot-token", type: "string", usage: "Telegram bot token; - reads it from stdin", defaultValue: "" },
    { name: "chat-id", type: "string", usage: "Telegram chat id", defaultValue: "" },
    { name: "thread-id", type: "string", usage: "topic thread id; '' clears it", defaultValue: "" },
    { name: "chat-label", type: "string", usage: "label for the chat; '' clears it", defaultValue: "" },
    ACTIVE_FLAG,
    ...EVENT_FLAGS,
  ],
  setLong:
    "Create or change the Telegram integration for the project.\n\n" +
    "With no integration on the project this posts a new one; --bot-token and\n" +
    "--chat-id are required then. The bot token is a secret: pass - and pipe it\n" +
    "on stdin, since a value on the command line shows in the process list and\n" +
    "the shell history. With an integration already there only the fields\n" +
    "passed change: --thread-id '' and --chat-label '' clear them, and\n" +
    "--active=false stops delivery without removing it. Event toggles merge\n" +
    "into the stored set.",
  api: {
    get: getTelegramIntegration,
    create: createTelegramIntegration,
    update: updateTelegramIntegration,
    remove: deleteTelegramIntegration,
  },
  secret: { flag: "bot-token", what: "bot token" },
  createBody: telegramCreateBody,
  updateBody: telegramUpdateBody,
  describe: telegramDescribe,
  createRefuses: { active: "does not apply to a new integration; it is created active" },
};

export const telegramCommand = chatProvider(telegramSpec);
