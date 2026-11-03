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
  handleUsage,
  usageSchema,
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
  connectSchema,
  handleConnect,
  codeGetSchema,
  codeDeploySchema,
  codeTestSchema,
  handleCodeGet,
  handleCodeDeploy,
  handleCodeTest,
} from "./tools";

/**
 * Every tool's annotations, in one table so the hosted endpoint can read them
 * too: /mcp lets an OAuth token with only anyhook:read call the read-only
 * tools and asks for anyhook:write before any other (MCP step-up).
 */
export const TOOL_ANNOTATIONS = {
  anyhook_mock: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  anyhook_verify: { readOnlyHint: true },
  anyhook_providers: { readOnlyHint: true },
  anyhook_quickstart: { readOnlyHint: false, destructiveHint: false },
  anyhook_apps_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  anyhook_inbox: { readOnlyHint: true },
  anyhook_apps_create: { readOnlyHint: false, destructiveHint: false },
  anyhook_connect: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  anyhook_replay: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  anyhook_undelivered: { readOnlyHint: true },
  anyhook_replay_failed: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  anyhook_events: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  anyhook_inspect: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  anyhook_simulate: { readOnlyHint: false, destructiveHint: false },
  anyhook_code_get: { readOnlyHint: true },
  anyhook_code_deploy: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  anyhook_code_test: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  anyhook_usage: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
} as const;

export type ServerOptions = {
  /** Override the loaded config (mainly for tests). */
  config?: McpConfig;
  /** Override the memory store (mainly for tests). */
  store?: EventStore;
  /** Inject a fake client for tests; ignored when config.mode is "local". */
  client?: AnyHookClient;
  /** Hosted /mcp authenticates through the HTTP bearer; never request a key in tool arguments. */
  hosted?: boolean;
  /** Small public-reviewable catalogue; the full stdio and hosted surfaces stay compatible. */
  profile?: "full" | "plugin";
};

function noKeyError() {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "No API key connected.",
        fix: "Run anyhook_quickstart first (free, no signup, creates an endpoint + key instantly). Over stdio, set ANYHOOK_API_KEY in your MCP config; over HTTP, send an Authorization: Bearer header.",
      }),
    }],
    isError: true,
  };
}

const EVENTS_UI_URI = "ui://anyhook/events-v1.html";

/**
 * Inline card for anyhook_events (MCP Apps / ChatGPT). Rendered in an iframe by
 * the host; it reads the tool's structuredContent from the bridge and draws one
 * row per event. Text-only hosts never see this; the tool's JSON text still
 * carries everything.
 */
const EVENTS_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#09090b; --muted:#52525b; --line:#e4e4e7; --card:#fafafa; --ok:#059669; --warn:#b45309; --bad:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0a0a0a; --fg:#fafafa; --muted:#a1a1aa; --line:#1f1f22; --card:#111113; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:10px 12px; font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--fg); }
  .head { display:flex; align-items:baseline; justify-content:space-between; margin:0 0 10px; }
  .title { font-weight:600; font-size:15px; }
  .count { color:var(--muted); font-size:12px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:10px 12px; border:1px solid var(--line); background:var(--card); border-radius:10px; margin-bottom:8px; }
  .type { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .meta { color:var(--muted); font-size:12px; margin-top:2px; font-family:ui-monospace, Menlo, monospace; }
  .side { text-align:right; flex:none; }
  .chip { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid var(--line); }
  .chip.delivered { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 35%, transparent); }
  .chip.failed { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 35%, transparent); }
  .chip.held { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 35%, transparent); }
  .time { color:var(--muted); font-size:11px; margin-top:4px; font-family:ui-monospace, Menlo, monospace; }
  .empty { color:var(--muted); padding:18px 4px; }
</style>
</head>
<body>
<div id="root"><div class="empty">Waiting for events…</div></div>
<script>
(function () {
  var root = document.getElementById('root');
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function render(data) {
    var events = data && Array.isArray(data.events) ? data.events : [];
    if (!events.length) { root.innerHTML = '<div class="empty">No events in this window.</div>'; return; }
    var html = '<div class="head"><span class="title">Recent events</span><span class="count">' + events.length + '</span></div>';
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var status = String(e.status == null ? '' : e.status);
      var cls = status === 'delivered' ? 'delivered' : status === 'failed' ? 'failed' : status === 'quota_exceeded' ? 'held' : '';
      var when = String(e.receivedAt || '').replace('T', ' ').slice(0, 16);
      html += '<div class="row"><div style="min-width:0"><div class="type">' + esc(e.eventType) + '</div><div class="meta">' + esc(e.source) + ' · ' + esc(String(e.id || '').slice(0, 8)) + '…</div></div>' +
        '<div class="side"><span class="chip ' + cls + '">' + esc(status) + '</span><div class="time">' + esc(when) + '</div></div></div>';
    }
    root.innerHTML = html;
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.method === 'ui/notifications/tool-result') render(m.params && m.params.structuredContent);
  }, { passive: true });
})();
</script>
</body>
</html>`;

function withStructuredEvents<T extends { content?: { type: string; text: string }[] }>(result: T): T & { structuredContent?: Record<string, unknown> } {
  try {
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && Array.isArray(parsed.events)) return { ...result, structuredContent: parsed };
  } catch {
    // Not JSON (an error string): leave the result as it is.
  }
  return result;
}

export function createAnyHookMcpServer(opts: ServerOptions = {}): McpServer {
  const config = opts.config ?? loadConfig();
  const store = opts.store ?? createMemoryStore({ maxEvents: 1000 });
  let client: AnyHookClient | null =
    opts.client ?? (config.mode === "remote" && config.apiKey ? new AnyHookClient(config) : null);
  const plugin = opts.profile === "plugin";

  // The stdio package keeps its historical optional api_key argument for
  // compatibility. Hosted HTTP always authenticates at the transport boundary;
  // advertising a per-tool key would invite users to paste credentials into
  // tool arguments even though the hosted route ignores that field.
  function accountSchema<T extends Record<string, unknown>>(schema: T, hostedOnlyFields: string[] = []): T {
    if (!opts.hosted) return schema;
    const copy = { ...schema } as Record<string, unknown>;
    delete copy.api_key;
    for (const field of hostedOnlyFields) delete copy[field];
    return copy as T;
  }

  // The branded icon travels with the server (MCP SEP-973): clients that render
  // implementation icons show the mark instead of the host's default, without
  // each user having to upload it.
  const ICONS = [{ src: "https://anyhook.net/icon.png", mimeType: "image/png", sizes: ["512x512"] }];

  const server = new McpServer(
    { name: "anyhook", version: "0.5.0", websiteUrl: "https://anyhook.net", icons: ICONS },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.registerResource(
    "anyhook-events-card",
    EVENTS_UI_URI,
    { icons: ICONS },
    async () => ({
      contents: [
        {
          uri: EVENTS_UI_URI,
          mimeType: "text/html;profile=mcp-app",
          text: EVENTS_UI_HTML,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    })
  );

  // ── Always-on provider toolkit ───────────────────────────────────────────
  if (!plugin) server.registerTool(
    "anyhook_mock",
    {
      annotations: TOOL_ANNOTATIONS.anyhook_mock,
      title: "Mock a webhook",
      description:
        "Generate a webhook request with a valid signature for Stripe, GitHub, or Slack. " +
        "If targetUrl is provided, the request is POSTed there and the response is returned.",
      inputSchema: mockSchema,
    },
    async (input) => handleMock(input)
  );

  if (!plugin) server.registerTool(
    "anyhook_verify",
    {
      annotations: TOOL_ANNOTATIONS.anyhook_verify,
      title: "Verify a webhook signature",
      description:
        "Verify a webhook signature against a secret, for every source the AnyHook edge verifies, including " +
        "stripe, github, shopify, slack, line, discord, linear, vercel, paddle, hubspot, paypal and xero.",
      inputSchema: verifySchema,
    },
    async (input) => handleVerify(input)
  );

  if (!plugin) server.registerTool(
    "anyhook_providers",
    {
      annotations: TOOL_ANNOTATIONS.anyhook_providers,
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
  if (!plugin && !config.apiKey) server.registerTool(
    "anyhook_quickstart",
    {
      annotations: TOOL_ANNOTATIONS.anyhook_quickstart,
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
        annotations: TOOL_ANNOTATIONS.anyhook_apps_list,
        title: "List your AnyHook apps",
        description:
          "List apps in your AnyHook account with inbound URLs, sources, and destination URLs. " +
          "Check isActive: an inactive app's inbound URL answers setup handshakes but acknowledges " +
          "and discards event POSTs (202, reason app_inactive) instead of relaying them. " +
          "Destination signing secrets are redacted to has_signing_secret plus a 4-char hint; " +
          "a new secret in plaintext comes only from rotating it. An app whose slug was changed " +
          "lists its former URLs under legacyInboundUrls; those still route to it.",
        inputSchema: accountSchema(appsListSchema),
      },
      async () => {
        if (!client) return noKeyError();
        return handleAppsList(undefined, client);
      }
    );

    if (!plugin) server.registerTool(
      "anyhook_inbox",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_inbox,
        title: "Get this app's email inbox address",
        description:
          "Every AnyHook app is also an email inbox: mail sent to {user}.{app}@anyhook.net " +
          "becomes an event (type email.received) you can read with anyhook_events. " +
          "Returns the address and webhook URL for one of your apps.",
        inputSchema: accountSchema(inboxSchema),
      },
      async (input: { app?: string }) => {
        if (!client) return noKeyError();
        return handleInbox(input ?? {}, client);
      }
    );

    if (!plugin) server.registerTool(
      "anyhook_apps_create",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_apps_create,
        title: "Create a new AnyHook app",
        description:
          "Create a new app with a name, provider source, and (optionally) destinations. Returns the inbound URL. " +
          "The app is active immediately. Created WITHOUT destinations it still receives and LOGS every event " +
          "(inspect-only), it just delivers nowhere until a destination is added " +
          "(PATCH /api/v1/apps/{slug} with {\"destinations\": [...]}).",
        inputSchema: accountSchema(appsCreateSchema),
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleAppsCreate(input, client);
      }
    );

    if (!plugin) server.registerTool(
      "anyhook_connect",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_connect,
        title: "Connect Stripe or GitHub with one key",
        description:
          "Wire a provider to AnyHook in one call: give a Stripe or GitHub key and AnyHook registers the app's inbound URL " +
          "as a webhook at the provider, saves the signing secret it yields, and turns on signature verification at the edge. " +
          "The provider is read from the key; the key is used once and not stored. Without appSlug a new app is created " +
          "(and removed again if the provider refuses the key). Re-running replaces the registration instead of duplicating it. " +
          "GitHub sends a signed ping immediately, so the first event appears within seconds. Add a destination afterwards " +
          "(PATCH /api/v1/apps/{slug}) to forward events; until then they are received and logged.",
        inputSchema: accountSchema(connectSchema),
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleConnect(input, client);
      }
    );



    server.registerTool(
      "anyhook_replay",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_replay,
        title: "Replay an event",
        description:
          "Re-send a stored event to its destinations. Replays sit outside the monthly event quota but within a daily replay limit per plan and the monthly compute allowance (anyhook_usage), and replaying an event that was held for quota bills it as a new event. The destination does run its handler again: a receiver that is not idempotent will process the event twice while debugging.",
        inputSchema: accountSchema(eventReplaySchema),
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleEventReplay(input, client);
      }
    );

    if (!plugin) server.registerTool(
      "anyhook_undelivered",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_undelivered,
        title: "List undelivered events for an app",
        description:
          "Show events for the given app that have not successfully reached any destination (failed or still retrying).",
        inputSchema: accountSchema(appUndeliveredSchema),
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleAppUndelivered(input, client);
      }
    );

    if (!plugin) server.registerTool(
      "anyhook_replay_failed",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_replay_failed,
        title: "Bulk-replay an app's failed events",
        description:
          "Re-send an app's failed events after the destination is fixed, oldest first: by default those received " +
          "in the last 24 hours, at most 50 per call (since and limit change both; limit goes up to 100). Events " +
          "held by an open circuit are included. An event replayed once is not selected again, so a second call " +
          "continues with the rest. The result lists what was replayed, what was skipped and why, and more: true " +
          "while failed events are still waiting. Replays count against the plan's daily replay limit.",
        inputSchema: accountSchema(appReplayFailedSchema),
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleAppReplayFailed(input, client);
      }
    );

    if (!plugin) server.registerTool(
      "anyhook_code_get",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_code_get,
        title: "Read an app's code handler",
        description:
          "The code that runs on this app's events: its source, the names of its secrets (never the values), " +
          "whether events are reaching it, and runs used this month against the plan's limit.",
        inputSchema: accountSchema(codeGetSchema),
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleCodeGet(input, client);
      }
    );

    if (!plugin) server.registerTool(
      "anyhook_code_deploy",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_code_deploy,
        title: "Deploy code that runs on an app's events",
        description:
          "Save a handler that runs on every event this app receives, in an isolated sandbox, with AnyHook's " +
          "retries and replay around it: no server of your own. Each run's console output and return value are " +
          "stored as that delivery's response (anyhook_inspect shows them). It can also run on a cron schedule. " +
          "Pro and Scale; runs are capped per month with no overage, retries, test runs and schedule firings each count, " +
          "and each run and package install is charged to the monthly compute allowance (anyhook_usage shows both). " +
          "Test it with anyhook_code_test before real events arrive.",
        inputSchema: accountSchema(codeDeploySchema),
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleCodeDeploy(input, client);
      }
    );

    if (!plugin) server.registerTool(
      "anyhook_code_test",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_code_test,
        title: "Run an app's code on a stored event",
        description:
          "Run the saved handler now and return its logs, return value and duration: on a stored event " +
          "(the latest when event_id is omitted) or on a body you give. Counts as a run. Nothing is delivered, " +
          "but whatever the code itself sends does happen.",
        inputSchema: accountSchema(codeTestSchema),
      },
      async (input) => {
        if (!client) return noKeyError();
        return handleCodeTest(input, client);
      }
    );

    server.registerTool(
      "anyhook_usage",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_usage,
        title: "Show plan limits and usage",
        description:
          "What the plan allows and what this account has used of each: events this month (per delivery, large " +
          "events count per 64 KB), overage, the compute allowance and what used it (retries, replays, waiting on " +
          "slow destinations, code runs, builds, schedules), API calls today (each tool call that reads or changes the account counts one), code runs " +
          "and package snapshots, with when each resets. Call it when something answers with a limit, before " +
          "bulk work such as replay_failed, or when the user asks what they are using.",
        inputSchema: accountSchema(usageSchema),
      },
      async () => {
        if (!client) return noKeyError();
        return handleUsage(undefined, client);
      }
    );
  }

  // ── Events & inspect, single registration, mode-aware dispatch ──────────
  server.registerTool(
    "anyhook_events",
    {
      annotations: TOOL_ANNOTATIONS.anyhook_events,
      title: "List recent webhook events",
      description:
        "List webhook events, most recent first: id, app, type, status, attempt, destination " +
        "status code, latency, timestamp. Summaries only, no request headers or body; " +
        "anyhook_inspect reads one event's payload by the id from here. Uses your AnyHook " +
        "account when connected, otherwise the local in-memory store.",
      // `source` filters only the stdio in-memory store; the hosted REST API
      // ignores it, so the Plugin must never advertise it as a working filter.
      inputSchema: accountSchema(eventsListUnifiedSchema, ["source"]),
      _meta: {
        ui: { resourceUri: EVENTS_UI_URI },
        "openai/toolInvocation/invoking": "Loading events…",
        "openai/toolInvocation/invoked": "Loaded.",
      },
    },
    async (input: Record<string, unknown>) => {
      if (client) return withStructuredEvents(await handleEventsListRemote(input, client));
      // remote-without-key (HTTP keyless session): a fresh memory store per
      // request would silently return []: steer the agent to a key instead
      if (config.mode === "remote") return noKeyError();
      return withStructuredEvents(await handleEventsList(input, store));
    }
  );

  server.registerTool(
    "anyhook_inspect",
    {
      annotations: TOOL_ANNOTATIONS.anyhook_inspect,
      title: "Inspect a specific event",
      description:
        "Full detail for one event by id, including the inbound headers and body that " +
        "anyhook_events omits, plus the destination's response. Payloads can be large and " +
        "often contain personal data, so fetch one at a time, only when the body is needed. " +
        "Account or local store.",
      inputSchema: accountSchema(eventInspectSchema),
    },
    async (input) => {
      if (client) return handleEventInspectRemote(input, client);
      if (config.mode === "remote") return noKeyError();
      return handleEventInspect(input, store);
    }
  );

  if (config.mode === "local" && !plugin) {
    // Local-only: simulate inserts mocked events into the in-memory store.


    server.registerTool(
      "anyhook_simulate",
      {
        annotations: TOOL_ANNOTATIONS.anyhook_simulate,
        title: "Simulate an incoming webhook (local only)",
        description:
          "Generate a mocked webhook AND insert it into the local memory store, so list/inspect flows can be exercised without a real provider. " +
          "Not available in remote mode, where a real inbound URL takes the place of the store.",
        inputSchema: eventsSimulateSchema,
      },
      async (input) => handleEventsSimulate(input, store)
    );
  }

  return server;
}
