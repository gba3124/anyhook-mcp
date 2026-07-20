/**
 * Tool handlers — pure functions that take typed input and a backing
 * source (in-memory store OR live API client), return MCP-shaped responses.
 *
 * Tools fall into three groups:
 *   - Provider-only (mock / verify / providers) — work without any backend
 *   - Store-backed (events / inspect / simulate) — work against memory store in
 *     local mode; the same names re-register against the live API in remote mode
 *   - Remote-only (apps:list / apps:create / event:replay / undelivered /
 *     replay-failed) — require ANYHOOK_API_KEY
 */
import { z } from "zod";
import { mock, listProviders, listEvents } from "@anyhook/core/mock";
import { verifySignature } from "@anyhook/core/signature";
import type { EventStore, NewEventInput } from "@anyhook/core/store";
import type { AnyHookClient } from "./client";
import { AnyHookApiError } from "./client";

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

export const eventsListSchema = {
  status: z.enum(["received", "forwarded", "failed", "retrying"]).optional(),
  source: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
};

export const eventInspectSchema = {
  id: z.string().describe("Event ID returned by anyhook_events."),
};

export const providersSchema = {};

export const eventsSimulateSchema = {
  provider: z.enum(["stripe", "github", "slack"]),
  event: z.string(),
  data: z.record(z.unknown()).optional(),
  secret: z.string().optional(),
};

// Remote-mode schemas
export const eventsListUnifiedSchema = {
  appSlug: z.string().optional().describe("Filter to a specific app slug (account mode)."),
  source: z.string().optional().describe("Filter by provider source (local mode)."),
  status: z.string().optional()
    .describe("Filter by status. Account mode: queued|success|retrying|failed. Local mode: received|forwarded|failed|retrying."),
  limit: z.number().int().min(1).max(200).optional(),
};

export const eventsListRemoteSchema = {
  appSlug: z.string().optional().describe("Filter to a specific app slug."),
  status: z.enum(["queued", "success", "retrying", "failed"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

export const eventReplaySchema = {
  id: z.string().describe("Event ID to replay. Replay does not consume event quota."),
};

export const appsListSchema = {};

export const quickstartSchema = {
  destination_url: z.string().url().optional()
    .describe("Optional forwarding destination for the new endpoint."),
  source: z.string().optional()
    .describe("Optional provider hint (stripe, github, shopify, ...)."),
};

export const appsCreateSchema = {
  name: z.string().describe("Human-readable app name."),
  source: z
    .string()
    .describe("Provider name (stripe, github, shopify, ...). Used for signature auto-detection."),
  destinations: z
    .array(z.object({ url: z.string().url() }))
    .optional()
    .describe("Destination URLs that should receive forwarded events."),
};

export const appUndeliveredSchema = {
  appSlug: z.string(),
  limit: z.number().int().min(1).max(200).optional(),
};

export const appReplayFailedSchema = {
  appSlug: z.string().describe("Bulk-replay every failed event for this app."),
};

// ────────────────────────────────────────────────────────────────────────────
// Handlers
// ────────────────────────────────────────────────────────────────────────────

// Shared MCP tool-call result shape so handlers and tests can both rely on
// `isError` being part of the static type (some branches set it, success
// branches omit it — without this declaration TypeScript narrows it away).
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
 * Simulate a webhook event hitting the local store — used in dev mode to
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
// Remote-mode handlers — talk to the live AnyHook API via AnyHookClient.
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
  // The list endpoint returns one event at a time when we filter precisely;
  // there is no dedicated GET /events/{id} in the v1 API today. We surface
  // a sharp message rather than silently returning nothing.
  try {
    const { events } = await client.listEvents({ limit: 200 });
    const found = events.find((e) => e.id === input.id);
    if (!found) return asErrorContent(`No event with id '${input.id}' in the latest 200 events`);
    return asTextContent(found);
  } catch (err) {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return asTextContent({ error: body?.error ?? `quickstart failed (${res.status})` });
    }
    return asTextContent({
      ...body,
      mcp_note:
        "This MCP session is now connected to the new account — remote tools " +
        "(anyhook_events, anyhook_apps_create, ...) work immediately. To persist " +
        "across sessions, set ANYHOOK_API_KEY to the api_key above in your MCP " +
        "config. Open claim_url in a browser to keep the endpoint permanently.",
    });
  } catch (err) {
    return asApiError(err);
  }
}
