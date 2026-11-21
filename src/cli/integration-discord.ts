import {
  createDiscordIntegration,
  deleteDiscordIntegration,
  getDiscordIntegration,
  updateDiscordIntegration,
} from "../api/kaneo";
import { chatProvider, webhookSpec } from "./integration-chat";

// Discord posts a project's events to a Discord webhook URL; it shares the
// whole webhook spec with slack and differs only in the routes it calls.
export const discordCommand = chatProvider(
  webhookSpec("discord", "Discord", {
    get: getDiscordIntegration,
    create: createDiscordIntegration,
    update: updateDiscordIntegration,
    remove: deleteDiscordIntegration,
  }),
);
