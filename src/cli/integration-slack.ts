import {
  createSlackIntegration,
  deleteSlackIntegration,
  getSlackIntegration,
  updateSlackIntegration,
} from "../api/kaneo";
import { chatProvider, webhookSpec } from "./integration-chat";

// Slack posts a project's events to a Slack webhook URL; it shares the whole
// webhook spec with discord and differs only in the routes it calls.
export const slackCommand = chatProvider(
  webhookSpec("slack", "Slack", {
    get: getSlackIntegration,
    create: createSlackIntegration,
    update: updateSlackIntegration,
    remove: deleteSlackIntegration,
  }),
);
