import { z } from "zod";

export const INBOX_PROMPT = "webhook-inbox-catch-up";
export const INBOX_QUESTION = "What arrived in my webhook inbox in the last 24 hours, and which deliveries need attention?";

export const inboxPromptConfig = {
  title: "Catch up on webhook deliveries",
  description: "Get a read-only recap of the last 24 hours in one webhook inbox or across your connected inboxes.",
  argsSchema: {
    appSlug: z.string().max(64).regex(/^[a-z0-9-]*$/).optional()
      .describe("App slug, such as order-updates. Leave empty for all apps in this account or workspace."),
  },
};

export function inboxCatchUp(scope: "account" | "workspace" | "disconnected", appSlug?: string) {
  const inbox = appSlug ? `app "${appSlug}" in this ${scope}` : `the apps in this ${scope}`;
  const text = scope === "disconnected"
    ? "Help me reconnect my existing hosted webhook inbox. This local session can only list simulated events. " +
      "Explain how to set my existing ANYHOOK_API_KEY in my MCP client's secret settings, or sign in to the same account at https://anyhook.net/mcp. " +
      "Keep credentials out of chat and keep my existing endpoint."
    : `Summarize the last 24 hours of webhook events for ${inbox}. Read event summaries with anyhook_events. ` +
      "Keep the same inclusive since timestamp and app filter on each page. Follow nextCursor until it is null, " +
      "count each event ID once, and tell me if you could only read part of the window. " +
      "Show what arrived by event type. Distinguish stored-only events from confirmed forwarding and leave unconfirmed outcomes labeled as such. " +
      "Highlight failures, rejections, holds and ongoing retries with their event IDs. If no events matched, say so. " +
      "Leave payloads unopened and do not replay events or change any settings.";
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}
