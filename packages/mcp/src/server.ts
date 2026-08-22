/**
 * AnyHook MCP server, wires tool handlers into the MCP protocol.
 *
 * Two modes, picked from config (driven by env vars at boot):
 *
 *   - local mode (no ANYHOOK_API_KEY): provider toolkit + memory event store.
 *     Useful for trying the server out, mocking webhooks for a local handler,
 *     and exercising the events flow without an account.
 *   - remote mode (ANYHOOK_API_KEY set): provider toolkit PLUS live tools
 *     that query the user's real AnyHook account: list apps, create apps,
 *     list events, inspect, replay, list undelivered, bulk-replay-failed.
 *
 * The simulate / memory-only tools are not registered in remote mode to
 * avoid confusion between "simulated event in your local memory" and "real
 * event in your account".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMemoryStore } from "@anyhook/core/store";
import type { EventStore } from "@anyhook/core/store";
import { AnyHookClient } from "./client";
import { loadConfig, type McpConfig } from "./config";
import {
  quickstartSchema,
  handleQuickstart,
  eventsListUnifiedSchema,
  handleMock,
  handleVerify,
  handleEventsList,
  handleEventInspect,
  handleProviders,
  handleEventsSimulate,
  handleEventsListRemote,
  handleEventInspectRemote,
  handleEventReplay,
  handleAppsList,
  handleInbox,
  handleAppsCreate,
  handleAppUndelivered,
  handleAppReplayFailed,
  mockSchema,
  verifySchema,
  eventInspectSchema,
  providersSchema,
  eventsSimulateSchema,
  eventReplaySchema,
  appsListSchema,
  inboxSchema,
  appsCreateSchema,
  appUndeliveredSchema,
  appReplayFailedSchema,
} from "./tools";

export type ServerOptions = {
  /** Override the loaded config (mainly for tests). */
  config?: McpConfig;
  /** Override the memory store (mainly for tests). */
  store?: EventStore;
  /** Inject a fake client for tests; ignored when config.mode is "local". */
  client?: AnyHookClient;
};

function noKeyError() {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "No API key connected.",
        fix: "Run anyhook_quickstart first (free, no signup, creates an endpoint + key instantly). Over stdio, set ANYHOOK_API_KEY in your MCP config; over HTTP, send an Authorization: Bearer header or pass the key as the api_key argument on any account tool.",
      }),
    }],
    isError: true,
  };
}

export function createAnyHookMcpServer(opts: ServerOptions = {}): McpServer {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? createMemoryStore({ maxEvents: 1000 });
  let client: AnyHookClient | null =
    opts.client ?? (config.mode === "remote" && config.apiKey ? new AnyHookClient(config) : null);

  const server = new McpServer(
    { name: "anyhook", version: "0.2.2" },
    { capabilities: { tools: {} } }
  );

  // ── Always-on provider toolkit ───────────────────────────────────────────
  server.registerTool(
    "anyhook_mock",
    {
      title: "Mock a webhook",
      description:
        "Generate a webhook request with a valid signature for Stripe, GitHub, or Slack. " +
        "If targetUrl is provided, the request is POSTed there and the response is returned.",
      inputSchema: mockSchema,
    },
    async (input) => handleMock(input)
  );

  server.registerTool(
    "anyhook_verify",
    {
      title: "Verify a webhook signature",
      description:
        "Verify a webhook signature against a secret. Supports 20 providers including " +
        "stripe, github, shopify, slack, line, discord, linear, vercel, paddle, hubspot, and paypal.",
      inputSchema: verifySchema,
    },
    async (input) => handleVerify(input)
  );

  server.registerTool(
    "anyhook_providers",
    {
      title: "List supported providers and event types",
      description:
        "List webhook providers AnyHook can mock, along with the event types available for each.",
      inputSchema: providersSchema,
    },
    async () => handleProviders()
  );

  // Only offered to sessions that have no account yet. With a key (or an OAuth
  // token on the hosted endpoint) the user already has an account, and a
  // quickstart would create a second, ephemeral one they can't see.
  if (!config.apiKey) server.registerTool(
    "anyhook_quickstart",
    {
      title: "Create a free AnyHook endpoint (no account needed)",
      description:
        "Zero-config bootstrap: creates a free ephemeral relay endpoint + API key with no signup. " +
        "Returns inbound_url (receives webhooks immediately), api_key, and claim_url. " +
          "Relay claim_url to your user before the session ends, unclaimed workspaces self-delete in 7 days. " +
        "This MCP session auto-connects to the new account; remote tools work right after. " +
        "Endpoint expires in 7 days unless claimed.",
      inputSchema: quickstartSchema,
    },
    async (input: { destination_url?: string; source?: string }) => {
      const result = await handleQuickstart(input ?? {}, config.apiBase);
      // 成功時就地升級成 remote mode（回應含 api_key 才算成功）
      try {
        const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
        const parsed = JSON.parse(text) as { api_key?: string };
        if (parsed.api_key) {
          config.apiKey = parsed.api_key;
          config.mode = "remote";
          client = new AnyHookClient(config);
        }
      } catch { /* 非 JSON 或失敗回應：維持原狀 */ }
      return result;
    }
  );

  // ── Account tools, always registered; guarded until a key exists ────────
  {
    // Remote mode: tools query the user's live AnyHook account
    server.registerTool(
      "anyhook_apps_list",
      {
        title: "List your AnyHook apps",
        description:
          "List apps in your AnyHook account with inbound URLs, sources, and destination URLs. " +
          "Check isActive: an inactive app's inbound URL answers setup handshakes but acknowledges " +
          "and discards event POSTs (202, reason app_inactive) instead of relaying them. " +
          "Destination signing secrets are redacted to has_signing_secret plus a 4-char hint; " +
          "a new secret in plaintext comes only from rotating it. An app whose slug was changed " +
          "lists its former URLs under legacyInboundUrls; those still route to it.",
        inputSchema: appsListSchema,
      },
      async () => {
        if (!client) return noKeyError();
        return handleAppsList(undefined, client);
      }
    );

    server.registerTool(
      "anyhook_inbox",
      {
        title: "Get this app's email inbox address",
        description:
          "Every AnyHook app is also an email inbox: mail sent to {user}.{app}@anyhook.net " +
          "becomes an event (type email.received) you can read with anyhook_events. " +
          "Returns the address and webhook URL for one of your apps. " +
          "No account yet? anyhook_quickstart returns an inbox_address directly.",
        inputSchema: inboxSchema,
      },
      async (input: { app?: string }) => {
        if (!client) return noKeyError();
        return handleInbox(input ?? {}, client);
      }
    );

    server.registerTool(
      "anyhook_apps_create",
      {
        title: "Create a new AnyHook app",
        description:
          "Create a new app with a name, provider source, and (optionally) destinations. Returns the inbound URL. " +
          "The app is active immediately. Created WITHOUT destinations it still receives and LOGS every event " +
          "(inspect-only), it just delivers nowhere until a destination is added " +
          "(PATCH /api/v1/apps/{slug} with {\"destinations\": [...]}).",
        inputSchema: appsCreateSchema,
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleAppsCreate(input, client);
      }
    );



    server.registerTool(
      "anyhook_replay",
      {
        title: "Replay an event",
        description:
          "Re-send a stored event to its destinations. Replay does NOT consume monthly event quota, safe to call repeatedly while debugging.",
        inputSchema: eventReplaySchema,
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleEventReplay(input, client);
      }
    );

    server.registerTool(
      "anyhook_undelivered",
      {
        title: "List undelivered events for an app",
        description:
          "Show events for the given app that have not successfully reached any destination (failed or still retrying).",
        inputSchema: appUndeliveredSchema,
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleAppUndelivered(input, client);
      }
    );

    server.registerTool(
      "anyhook_replay_failed",
      {
        title: "Bulk-replay all failed events for an app",
        description:
          "Re-send every failed event for the given app slug. Useful after fixing a downstream bug to recover queued work.",
        inputSchema: appReplayFailedSchema,
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleAppReplayFailed(input, client);
      }
    );
  }

  // ── Events & inspect, single registration, mode-aware dispatch ──────────
  server.registerTool(
    "anyhook_events",
    {
      title: "List recent webhook events",
      description:
        "List webhook events, most recent first: id, app, type, status, attempt, destination " +
        "status code, latency, timestamp. Summaries only, no request headers or body — call " +
        "anyhook_inspect with an id from here to read one event's payload. Uses your AnyHook " +
        "account when connected, otherwise the local in-memory store.",
      inputSchema: eventsListUnifiedSchema,
    },
    async (input: Record<string, unknown>) => {
      if (client) return handleEventsListRemote(input, client);
      // remote-without-key (HTTP keyless session): a fresh memory store per
      // request would silently return []: steer the agent to a key instead
      if (config.mode === "remote") return noKeyError();
      return handleEventsList(input, store);
    }
  );

  server.registerTool(
    "anyhook_inspect",
    {
      title: "Inspect a specific event",
      description:
        "Full detail for one event by id, including the inbound headers and body that " +
        "anyhook_events omits, plus the destination's response. Payloads can be large and " +
        "often contain personal data, so fetch one at a time, only when the body is needed. " +
        "Account or local store.",
      inputSchema: eventInspectSchema,
    },
    async (input) => {
      if (client) return handleEventInspectRemote(input, client);
      if (config.mode === "remote") return noKeyError();
      return handleEventInspect(input, store);
    }
  );

  if (config.mode === "local") {
    // Local-only: simulate inserts mocked events into the in-memory store.


    server.registerTool(
      "anyhook_simulate",
      {
        title: "Simulate an incoming webhook (local only)",
        description:
          "Generate a mocked webhook AND insert it into the local memory store, so list/inspect flows can be exercised without a real provider. " +
          "Not available in remote mode, use anyhook_mock + your real inbound URL there.",
        inputSchema: eventsSimulateSchema,
      },
      async (input) => handleEventsSimulate(input, store)
    );
  }

  return server;
}
