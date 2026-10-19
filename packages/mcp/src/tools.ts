/**
 * Tool handlers, pure functions that take typed input and a backing
 * source (in-memory store OR live API client), return MCP-shaped responses.
 *
 * Tools fall into three groups:
 *   - Provider-only (mock / verify / providers): work without any backend
 *   - Store-backed (events / inspect / simulate): work against memory store in
 *     local mode; the same names re-register against the live API in remote mode
 *   - Remote-only (apps:list / apps:create / event:replay / undelivered /
 *     replay-failed): require ANYHOOK_API_KEY
 */
import { z } from "zod";
import { mock, listProviders, listEvents } from "@anyhook/core/mock";
import { verifySignature } from "@anyhook/core/signature";
import type { EventStore, NewEventInput } from "@anyhook/core/store";
import type { AnyHookClient } from "./client";
import { AnyHookApiError } from "./client";
import { USER_AGENT } from "./config";

// ────────────────────────────────────────────────────────────────────────────
// Input schemas (Zod)
// ────────────────────────────────────────────────────────────────────────────

export const mockSchema = {
  provider: z.enum(["stripe", "github", "slack"])
    .describe("Webhook provider to simulate."),
  event: z.string()
    .describe("Event name (e.g. 'payment_intent.succeeded' for Stripe)."),
  data: z.record(z.unknown()).optional()
    .describe("Optional fields to deep-merge into the fixture."),
  secret: z.string().optional()
    .describe("Signing secret. Falls back to a deterministic default per provider."),
  targetUrl: z.string().url().optional()
    .describe("If set, POST the generated request to this URL and return the response."),
};

export const verifySchema = {
  provider: z.string()
    .describe("Provider name (e.g. 'stripe', 'github', 'slack', 'generic')."),
  headers: z.record(z.string())
    .describe("Request headers as a flat object."),
  body: z.string()
    .describe("Raw request body."),
  secret: z.string()
    .describe("Signing secret to verify against."),
  requestUrl: z.string().url().optional()
    .describe("Original request URL (required for Twilio/HubSpot). Defaults to a placeholder."),
};

export const eventInspectSchema = {
  id: z.string().describe("Event ID returned by anyhook_events."),
  api_key: z.string().optional()
    .describe("API key (ahk_live_...) from anyhook_quickstart. Only needed over HTTP when no Authorization header is set; ignored over stdio."),
};

export const providersSchema = {};

export const eventsSimulateSchema = {
  provider: z.enum(["stripe", "github", "slack"]),
  event: z.string(),
  data: z.record(z.unknown()).optional(),
  secret: z.string().optional(),
};

// Remote-mode schemas

// Over streamable HTTP the transport is stateless, so a keyless session can't
// keep the key quickstart minted. Account tools accept it per call instead;
// the HTTP route consumes this argument and strips it before dispatch.
export const apiKeyParam = {
  api_key: z.string().optional()
    .describe("API key (ahk_live_...) from anyhook_quickstart. Only needed over HTTP when no Authorization header is set; ignored over stdio."),
};

export const eventsListUnifiedSchema = {
  ...apiKeyParam,
  appSlug: z.string().optional().describe("Filter to a specific app slug (account mode)."),
  source: z.string().optional().describe("Filter by provider source (local mode)."),
  status: z.string().optional()
    .describe("Filter by status. Account mode: queued|success|retrying|failed. Local mode: received|forwarded|failed|retrying."),
  limit: z.number().int().min(1).max(200).optional(),
};

export const eventReplaySchema = {
  ...apiKeyParam,
  id: z.string().describe("Event ID to replay. Replay does not consume event quota."),
};

export const appsListSchema = { ...apiKeyParam };

export const inboxSchema = {
  ...apiKeyParam,
  app: z.string().optional()
    .describe("App slug (from anyhook_apps_list). Defaults to your first app."),
};

export const quickstartSchema = {
  destination_url: z.string().url().optional()
    .describe("Optional forwarding destination for the new endpoint."),
  source: z.string().optional()
    .describe("Optional provider hint (stripe, github, shopify, ...)."),
};

export const appsCreateSchema = {
  ...apiKeyParam,
  name: z.string().describe("Human-readable app name."),
  source: z
    .string()
    .describe("Provider name (stripe, github, shopify, ...). Used for signature auto-detection."),
  destinations: z
    .array(z.object({ url: z.string().url() }))
    .optional()
    .describe("Destination URLs that should receive forwarded events."),
};

export const connectSchema = {
  ...apiKeyParam,
  provider_key: z
    .string()
    .describe(
      "A Stripe secret or restricted key (sk_… / rk_…) or a GitHub token (github_pat_… / ghp_…). " +
        "The provider is read from the key. Used once to register the webhook at the provider; AnyHook does not store it. " +
        "Least privilege: a Stripe restricted key with Webhook Endpoints = Write, or a fine-grained GitHub token with Webhooks = Read and write."
    ),
  appSlug: z.string().optional().describe("Connect this existing app. Omit to create a new app for the provider."),
  target: z
    .string()
    .optional()
    .describe('GitHub only: "owner/repo", or an organization name for an org-wide hook. Optional when the token administers exactly one repository.'),
};

export const appUndeliveredSchema = {
  ...apiKeyParam,
  appSlug: z.string(),
  limit: z.number().int().min(1).max(200).optional(),
};

export const codeGetSchema = {
  ...apiKeyParam,
  appSlug: z.string().describe("The app whose code handler to read."),
};

export const codeDeploySchema = {
  ...apiKeyParam,
  appSlug: z.string().describe("The app whose events the code runs on."),
  code: z
    .string()
    .describe(
      "An ES module, run in a sandboxed Node.js on every event this app receives. Either " +
        "`export default async function (event, { env }) {}` (event: { method, headers, body, raw_body, delivery_id, attempt }; " +
        "method is always POST, and the query string, path and caller IP are not kept) " +
        "or a Pipedream Node.js code step: `export default defineComponent({ async run({ steps, $ }) {} })`, where " +
        "steps.trigger.event is that same event (a step reading query, path, url or client_ip needs changing) and " +
        "$.export and $.flow.exit work. npm packages it imports are installed on deploy " +
        "(pin as \"pkg@1.2.3\", like Pipedream; a new package list usually takes seconds, a large one a few minutes). @pipedream/platform is a stand-in. " +
        "State between events: the app's store (store.get/set/has/delete/keys, set takes { ttl }); every data_store prop is that one store, " +
        "an app prop's this.<prop>.$auth.<field> reads the secret <APP>_<FIELD>, any other prop the secret named after it (channelId → CHANNEL_ID). " +
        "Throwing fails the delivery, which AnyHook retries. Templates for common actions (Slack, email, Google Sheets, " +
        "Notion, Claude and more): https://anyhook.net/code-templates.md"
    ),
  secrets: z
    .record(z.string(), z.string().nullable())
    .optional()
    .describe("Environment variables for the code, read as env.NAME or process.env.NAME. Merged into the saved ones; null removes a name."),
  schedule: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Also run on a cron schedule: five fields, UTC unless prefixed CRON_TZ=Area/City, e.g. \"*/15 * * * *\". " +
        "Each firing arrives as an anyhook.schedule event and counts as a run. null removes it; omit to keep it. " +
        "Only on an app that does not verify a sender's signature."
    ),
  enabled: z
    .boolean()
    .optional()
    .describe(
      "Whether events run the code. false saves it switched off, so it runs only through anyhook_code_test. " +
        "Omit: a first deploy goes live and later deploys keep the current state. Deploy off while another system " +
        "still handles the same events, or both will act on each one."
    ),
};

export const codeTestSchema = {
  ...apiKeyParam,
  appSlug: z.string(),
  event_id: z.string().optional().describe("Run on this stored event. Omit for the app's latest event."),
  body: z.unknown().optional().describe("Run on this body instead of a stored event."),
};

export const appReplayFailedSchema = {
  ...apiKeyParam,
  appSlug: z.string().describe("Bulk-replay every failed event for this app."),
};

// ────────────────────────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────────────────────────

// Shared MCP tool-call result shape so handlers and tests can both rely on
// `isError` being part of the static type (some branches set it, success
// branches omit it, without this declaration TypeScript narrows it away).
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function asTextContent(value: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function asErrorContent(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export async function handleMock(input: {
  provider: "stripe" | "github" | "slack";
  event: string;
  data?: Record<string, unknown>;
  secret?: string;
  targetUrl?: string;
}) {
  try {
    const req = await mock({
      provider: input.provider,
      event: input.event,
      data: input.data,
      secret: input.secret,
    });

    if (input.targetUrl) {
      const startedAt = Date.now();
      const res = await fetch(input.targetUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
      });
      const responseBody = await res.text();
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
      return asTextContent({
        sent: { method: req.method, headers: req.headers, body: req.body },
        response: {
          status: res.status,
          headers: responseHeaders,
          body: responseBody,
          latencyMs: Date.now() - startedAt,
        },
      });
    }

    return asTextContent({
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
  } catch (err) {
    return asErrorContent(err instanceof Error ? err.message : String(err));
  }
}

export async function handleVerify(input: {
  provider: string;
  headers: Record<string, string>;
  body: string;
  secret: string;
  requestUrl?: string;
}) {
  try {
    const valid = await verifySignature(
      input.provider,
      new Headers(input.headers),
      input.body,
      input.secret,
      input.requestUrl ?? "https://example.com/webhook"
    );
    return asTextContent({ valid, provider: input.provider });
  } catch (err) {
    return asErrorContent(err instanceof Error ? err.message : String(err));
  }
}

export async function handleEventsList(
  input: { status?: string; source?: string; limit?: number },
  store: EventStore
) {
  const { events, nextCursor } = await store.list({
    status: input.status as never,
    source: input.source,
    limit: input.limit,
  });
  return asTextContent({
    events: events.map((e) => ({
      id: e.id,
      receivedAt: e.receivedAt.toISOString(),
      source: e.source,
      eventType: e.eventType,
      status: e.status,
      signatureValid: e.signature?.valid ?? null,
      deliveryAttempts: e.delivery.length,
    })),
    nextCursor,
  });
}

export async function handleEventInspect(
  input: { id: string },
  store: EventStore
) {
  const event = await store.get(input.id);
  if (!event) return asErrorContent(`No event with id '${input.id}'`);
  return asTextContent({
    ...event,
    receivedAt: event.receivedAt.toISOString(),
    delivery: event.delivery.map((d) => ({ ...d, startedAt: d.startedAt.toISOString() })),
  });
}

export async function handleProviders() {
  const providers = listProviders();
  const catalog = providers.map((p) => ({
    provider: p,
    events: listEvents(p),
  }));
  return asTextContent({ providers: catalog });
}

/**
 * Simulate a webhook event hitting the local store, used in dev mode to
 * exercise the inspect/list/replay flow without a real provider.
 */
export async function handleEventsSimulate(
  input: { provider: "stripe" | "github" | "slack"; event: string; data?: Record<string, unknown>; secret?: string },
  store: EventStore
) {
  try {
    const req = await mock({
      provider: input.provider,
      event: input.event,
      data: input.data,
      secret: input.secret,
    });

    const newEvent: NewEventInput = {
      source: input.provider,
      eventType: input.event,
      method: req.method,
      path: "/webhook/simulated",
      headers: req.headers,
      body: req.body,
      bodyEncoding: "utf8",
      signature: { provider: input.provider, valid: true },
    };
    const inserted = await store.insert(newEvent);
    return asTextContent({
      id: inserted.id,
      source: inserted.source,
      eventType: inserted.eventType,
      status: inserted.status,
      receivedAt: inserted.receivedAt.toISOString(),
    });
  } catch (err) {
    return asErrorContent(err instanceof Error ? err.message : String(err));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Remote-mode handlers, talk to the live AnyHook API via AnyHookClient.
// Surfaced only when ANYHOOK_API_KEY is set.
// ────────────────────────────────────────────────────────────────────────────

function asApiError(err: unknown) {
  if (err instanceof AnyHookApiError) {
    return asErrorContent(`AnyHook API ${err.status}: ${err.message}`);
  }
  return asErrorContent(err instanceof Error ? err.message : String(err));
}

export async function handleEventsListRemote(
  input: { appSlug?: string; status?: string; limit?: number },
  client: AnyHookClient
) {
  try {
    const result = await client.listEvents(input);
    return asTextContent(result);
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleEventInspectRemote(
  input: { id: string },
  client: AnyHookClient
) {
  // GET /api/v1/events/{id}: one row, payload included. This used to pull the
  // latest 200 events and discard 199, which both cost a fortune in tokens and
  // could not see an event older than that window.
  try {
    const { event } = await client.getEvent(input.id);
    return asTextContent(event);
  } catch (err) {
    if (err instanceof Error && /\b404\b|not found/i.test(err.message)) {
      return asErrorContent(
        `No event with id '${input.id}'. Use anyhook_events to list recent event ids.`
      );
    }
    return asApiError(err);
  }
}

export async function handleEventReplay(
  input: { id: string },
  client: AnyHookClient
) {
  try {
    const result = await client.replayEvent(input.id);
    return asTextContent({ replayed: true, id: input.id, response: result });
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleInbox(input: { app?: string }, client: AnyHookClient) {
  try {
    const { apps } = await client.listApps();
    if (!apps.length) {
      return asTextContent({
        error: "No apps in this account.",
        fix: "Run anyhook_quickstart to create one, it returns an inbox_address directly.",
      });
    }

    const app = input.app ? apps.find((a) => a.slug === input.app) : apps[0];
    if (!app) {
      return asTextContent({
        error: `No app with slug '${input.app}'.`,
        available: apps.map((a) => a.slug),
      });
    }
    // Older API deploys don't return addresses; surface that rather than fabricating
    // one here, the address format is owned by the server, not this client.
    if (!app.inboxAddress) {
      return asTextContent({
        error: "This AnyHook server does not expose inbox addresses (self-hosted or outdated).",
        app: app.slug,
      });
    }

    return asTextContent({
      app: app.slug,
      inbox_address: app.inboxAddress,
      inbound_url: app.inboundUrl,
      note:
        "Any email sent to inbox_address becomes an event on this app (type email.received, " +
        "with from/to/subject and the full raw message). Read it with anyhook_events / anyhook_inspect.",
    });
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleAppsList(_input: unknown, client: AnyHookClient) {
  try {
    const result = await client.listApps();
    return asTextContent(result);
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleAppsCreate(
  input: { name: string; source: string; destinations?: { url: string }[] },
  client: AnyHookClient
) {
  try {
    const result = await client.createApp(input);
    return asTextContent(result);
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleConnect(
  input: { provider_key: string; appSlug?: string; target?: string },
  client: AnyHookClient
) {
  try {
    const result = await client.connect({ key: input.provider_key, app: input.appSlug, target: input.target });
    return asTextContent(result);
  } catch (err) {
    // The route answers failures as { error, detail, fix, candidates? }; pass all
    // of it through so the agent can act on the fix instead of a bare code.
    if (err instanceof AnyHookApiError && err.body && typeof err.body === "object") {
      return asErrorContent(JSON.stringify({ status: err.status, ...(err.body as Record<string, unknown>) }, null, 2));
    }
    return asApiError(err);
  }
}

export async function handleAppUndelivered(
  input: { appSlug: string; limit?: number },
  client: AnyHookClient
) {
  try {
    const result = await client.listUndelivered(input.appSlug, input.limit);
    return asTextContent(result);
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleCodeGet(input: { appSlug: string }, client: AnyHookClient) {
  try {
    return asTextContent(await client.getCode(input.appSlug));
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleCodeDeploy(
  input: { appSlug: string; code: string; secrets?: Record<string, string | null>; schedule?: string | null; enabled?: boolean },
  client: AnyHookClient
) {
  try {
    return asTextContent(
      await client.putCode(input.appSlug, { code: input.code, secrets: input.secrets, schedule: input.schedule, enabled: input.enabled })
    );
  } catch (err) {
    // The route explains refusals (plan, size, secret names); pass them through.
    if (err instanceof AnyHookApiError && err.body && typeof err.body === "object") {
      return asErrorContent(JSON.stringify({ status: err.status, ...(err.body as Record<string, unknown>) }, null, 2));
    }
    return asApiError(err);
  }
}

export async function handleCodeTest(input: { appSlug: string; event_id?: string; body?: unknown }, client: AnyHookClient) {
  try {
    return asTextContent(await client.testCode(input.appSlug, { event_id: input.event_id, body: input.body }));
  } catch (err) {
    if (err instanceof AnyHookApiError && err.body && typeof err.body === "object") {
      return asErrorContent(JSON.stringify({ status: err.status, ...(err.body as Record<string, unknown>) }, null, 2));
    }
    return asApiError(err);
  }
}

export async function handleAppReplayFailed(
  input: { appSlug: string },
  client: AnyHookClient
) {
  try {
    const result = await client.replayFailedForApp(input.appSlug);
    return asTextContent({ replayed: true, appSlug: input.appSlug, response: result });
  } catch (err) {
    return asApiError(err);
  }
}


/**
 * Zero-config bootstrap: create a free ephemeral AnyHook account + endpoint
 * + API key in one call (no signup). The server upgrades itself to remote
 * mode in-session with the returned key.
 */
export async function handleQuickstart(
  input: { destination_url?: string; source?: string },
  apiBase: string
) {
  try {
    const res = await fetch(`${apiBase}/api/v1/quickstart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(input ?? {}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return asTextContent({ error: body?.error ?? `quickstart failed (${res.status})` });
    }
    return asTextContent({
      ...body,
      mcp_note:
        "This MCP session is now connected to the new account, remote tools " +
        "(anyhook_events, anyhook_apps_create, ...) work immediately. To persist " +
        "across sessions, set ANYHOOK_API_KEY to the api_key above in your MCP " +
        "config. IMPORTANT, before this session ends, tell your user: this " +
        "workspace self-deletes in 7 days (inbound URL, key, and events included) " +
        "unless claimed. Claiming is one free browser sign-in at claim_url and " +
        "keeps everything permanently at the same URL. Offer them the link.",
    });
  } catch (err) {
    return asApiError(err);
  }
}
