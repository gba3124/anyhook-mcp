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
  data: z.record(z.string(), z.unknown()).optional()
    .describe("Optional fields to deep-merge into the fixture."),
  secret: z.string().optional()
    .describe("Signing secret. Falls back to a deterministic default per provider."),
  targetUrl: z.string().url().optional()
    .describe("If set, POST the generated request to this URL and return the response."),
};

export const verifySchema = {
  provider: z.string()
    .describe("Provider name (e.g. 'stripe', 'github', 'slack')."),
  headers: z.record(z.string(), z.string())
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
    .describe("Legacy field, ignored. Connect with ANYHOOK_API_KEY in the stdio client configuration."),
};

export const providersSchema = {};

export const eventsSimulateSchema = {
  provider: z.enum(["stripe", "github", "slack"]),
  event: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().optional(),
};

// Remote-mode schemas

// Kept for stdio compatibility. Hosted MCP only advertises transport authentication.
export const apiKeyParam = {
  api_key: z.string().optional()
    .describe("Legacy field, ignored. Connect with ANYHOOK_API_KEY in the stdio client configuration."),
};

export const eventsListUnifiedSchema = {
  ...apiKeyParam,
  appSlug: z.string().optional().describe("Filter to a specific app slug (account mode)."),
  source: z.string().optional().describe("Filter by provider source (local mode)."),
  status: z.string().optional()
    .describe("Filter by status. Account mode: queued|success|retrying|failed|rejected|circuit_open|quota_exceeded. Local mode: received|forwarded|failed|retrying."),
  limit: z.number().int().min(1).max(200).optional(),
  since: z.iso.datetime().max(27).optional().describe("Include events received at or after this UTC timestamp. When resuming, overlap the last read time and deduplicate by event id."),
  cursor: z.string().min(1).max(128).optional().describe("For the next page of older events, pass nextCursor from the previous page and keep the same filters."),
};

export const eventReplaySchema = {
  ...apiKeyParam,
  id: z.string().describe("Event ID to replay. Replay does not consume event quota; it is charged to the compute allowance."),
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
    .describe("Optional provider name (stripe, github, shopify, ...). Leave it out to accept any sender: naming one makes the edge refuse (401) requests without that provider's signature header, curl tests included."),
};

export const appsCreateSchema = {
  ...apiKeyParam,
  name: z.string().describe("Human-readable app name."),
  source: z
    .string()
    .optional()
    .describe("Optional provider name (stripe, github, shopify, ...). Leave it out to accept any sender: naming one makes the edge refuse (401) requests without that provider's signature header, curl tests included."),
  destinations: z
    .array(z.object({ url: z.string().url() }))
    .optional()
    .describe("Destination URLs that should receive forwarded events."),
};

export const destinationAddSchema = {
  ...apiKeyParam,
  appSlug: z.string().describe("The app whose events should be forwarded."),
  url: z.string().url().describe("Public https URL that receives each event as a POST."),
};

export const connectSchema = {
  ...apiKeyParam,
  provider: z
    .enum(["stripe", "github"])
    .optional()
    .describe("The provider to connect. Names the new app when appSlug is left out; Stripe if omitted."),
  appSlug: z.string().optional().describe("Connect this existing app. Omit to create a new app for the provider."),
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
        "Omit: a first deploy goes live and later deploys keep the current state. If another system still " +
        "handles the same events while this is on, both act on each one."
    ),
};

export const codeTestSchema = {
  ...apiKeyParam,
  appSlug: z.string(),
  event_id: z.string().optional().describe("Run on this stored event. Omit for the app's latest event."),
  body: z.record(z.string(), z.unknown()).optional().describe("Run on this JSON body instead of a stored event."),
};

export const usageSchema = { ...apiKeyParam };

export const appReplayFailedSchema = {
  ...apiKeyParam,
  appSlug: z.string().describe("The app whose failed events to replay."),
  since: z.string().optional().describe("Only events received after this ISO 8601 time. Default: 24 hours ago."),
  limit: z.number().int().min(1).max(100).optional().describe("Most events to replay in this call, 1 to 100. Default 50."),
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

/**
 * Every failure reads the same way, `{ error, detail?, fix? }` as JSON, the
 * shape the API refuses in, so an agent parses one thing whether the refusal
 * came from a route, the network or this package.
 */
function asErrorContent(problem: string | Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify(typeof problem === "string" ? { error: problem } : problem, null, 2),
    }],
  };
}

/** A hosted caller names the URL, so its answer is read only this far. The event log keeps as much. */
const HOSTED_MOCK_ANSWER_CHARS = 10_000;

async function readCapped(res: Response, maxChars: number): Promise<string> {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (reader && out.length < maxChars) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  await reader?.cancel().catch(() => {});
  return out.slice(0, maxChars);
}

export async function handleMock(input: {
  provider: "stripe" | "github" | "slack";
  event: string;
  data?: Record<string, unknown>;
  secret?: string;
  targetUrl?: string;
}, hosted?: {
  client: AnyHookClient;
  checkUrl?: (url: string) => { valid: boolean; reason?: string };
}) {
  try {
    const req = await mock({
      provider: input.provider,
      event: input.event,
      data: input.data,
      secret: input.secret,
    });

    if (input.targetUrl) {
      if (hosted) {
        // This POST leaves from AnyHook's server, so it needs what a delivery
        // needs: a real key, one metered call and a public URL. Reading the
        // usage does the first two.
        await hosted.client.usage();
        const check = hosted.checkUrl?.(input.targetUrl);
        if (!check?.valid) {
          return asErrorContent({
            error: "The hosted MCP server sends only to public https URLs.",
            detail: check?.reason,
            fix: "Leave out targetUrl to get the signed request back and send it yourself, or run npx -y anyhook-mcp, whose anyhook_mock can reach localhost.",
          });
        }
      }
      const startedAt = Date.now();
      const res = await fetch(input.targetUrl, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        // Only the first URL was checked, and a slow answer must not hold the function.
        ...(hosted ? { redirect: "manual" as const, signal: AbortSignal.timeout(10_000) } : {}),
      });
      const responseBody = hosted ? await readCapped(res, HOSTED_MOCK_ANSWER_CHARS) : await res.text();
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
    return asApiError(err);
  }
}

export async function handleVerify(input: {
  provider: string;
  headers: Record<string, string>;
  body: string;
  secret: string;
  requestUrl?: string;
}) {
  if (input.provider.trim().toLowerCase() === "generic") {
    return asTextContent({
      valid: null,
      checked: false,
      provider: input.provider,
      detail: "Generic has no signature scheme, so nothing was checked.",
    });
  }
  try {
    const valid = await verifySignature(
      input.provider,
      new Headers(input.headers),
      input.body,
      input.secret,
      input.requestUrl ?? "https://example.com/webhook"
    );
    if (!valid) {
      return asTextContent({
        valid,
        provider: input.provider,
        detail: "The signature did not match, or AnyHook has no scheme under this provider name. Check the secret, that the body is the raw bytes, and the name.",
      });
    }
    return asTextContent({ valid, provider: input.provider });
  } catch (err) {
    return asErrorContent(err instanceof Error ? err.message : String(err));
  }
}

export async function handleEventsList(
  input: { status?: string; source?: string; limit?: number; since?: string; cursor?: string },
  store: EventStore
) {
  const since = input.since ? new Date(input.since) : undefined;
  // The local store's clock has millisecond resolution. Round a finer inclusive
  // lower bound up, so a local event from just before it cannot reappear.
  const fraction = input.since?.match(/\.(\d+)Z$/)?.[1] ?? "";
  if (since && Number(fraction.slice(3)) > 0) since.setTime(since.getTime() + 1);
  const { events, nextCursor } = await store.list({
    status: input.status as never,
    source: input.source,
    limit: input.limit,
    since,
    cursor: input.cursor,
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
  if (!event) return asErrorContent({ error: `No event with id '${input.id}'.`, fix: "anyhook_events lists the ids in this session's store." });
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
    // Routes answer refusals as { error, detail?, fix?, ... }: a limit names
    // itself and what to do about it, so the agent gets all of it, not a bare code.
    if (err.body && typeof err.body === "object") {
      return asErrorContent({ status: err.status, ...(err.body as Record<string, unknown>) });
    }
    return asErrorContent({ status: err.status, error: err.message });
  }
  return asErrorContent(err instanceof Error ? err.message : String(err));
}

export async function handleEventsListRemote(
  input: { appSlug?: string; status?: string; limit?: number; since?: string; cursor?: string },
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
      return asErrorContent({
        status: 404,
        error: `No event with id '${input.id}'.`,
        fix: "anyhook_events lists recent event ids.",
      });
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
      return asErrorContent({
        error: "No apps in this account.",
        fix: "Use anyhook_apps_create with a name to create an inbox in this connected account, then call anyhook_inbox again.",
      });
    }

    const app = input.app ? apps.find((a) => a.slug === input.app) : apps[0];
    if (!app) {
      return asErrorContent({
        error: `No app with slug '${input.app}'.`,
        available: apps.map((a) => a.slug),
      });
    }
    // Older API deploys don't return addresses; surface that rather than fabricating
    // one here, the address format is owned by the server, not this client.
    if (!app.inboxAddress) {
      return asErrorContent({
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

/**
 * MCP never hands the agent a destination signing secret. The API shows a new
 * one once to an API key (the user's own script) and to nobody else, so a tool
 * result is cleaned of it here, and the note says where the user gets it.
 */
function withoutSigningSecrets(result: unknown, client: AnyHookClient, lead = ""): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key, v]) => !((key === "signing_secret" || key === "new_signing_secret") && typeof v === "string" && v !== ""))
      .map(([key, v]) => [key, strip(v)]));
  };
  const cleaned = strip(result);
  if (JSON.stringify(cleaned) === JSON.stringify(result)) return result;
  const slug = (result as { app?: { slug?: unknown } } | null)?.app?.slug;
  const page = client.dashboardUrl(typeof slug === "string" ? `/dashboard/apps/${encodeURIComponent(slug)}` : "/dashboard/apps");
  return {
    ...(cleaned as Record<string, unknown>),
    note: `${lead}The destination's signing secret stays out of this conversation. The user gets it on ${page}: ` +
      "Rotate on the destination shows a new one once, to verify the AnyHook-Signature header with on the receiving server.",
  };
}

export async function handleAppsCreate(
  input: { name: string; source?: string; destinations?: { url: string }[] },
  client: AnyHookClient
) {
  try {
    const result = await client.createApp(input);
    return asTextContent(withoutSigningSecrets(result, client));
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleDestinationAdd(input: { appSlug: string; url: string }, client: AnyHookClient) {
  try {
    const result = await client.addDestination(input.appSlug, input.url);
    return asTextContent(withoutSigningSecrets(result, client, "New events reach this URL within about a minute. "));
  } catch (err) {
    return asApiError(err);
  }
}

/**
 * The provider's key goes from the user into the dashboard, never through the
 * agent: this hands over the app's page, where they paste it, creating the app
 * first when there is none.
 */
export async function handleConnect(
  input: { provider?: "stripe" | "github"; appSlug?: string },
  client: AnyHookClient
) {
  try {
    let slug = input.appSlug;
    let created: unknown;
    if (!slug) {
      created = await client.createApp({ name: input.provider === "github" ? "GitHub" : "Stripe" });
      slug = (created as { app?: { slug?: string } }).app?.slug;
      if (!slug) return asApiError(new Error("The new app came back without a slug."));
    }
    return asTextContent({
      ...(created ? { created: withoutSigningSecrets(created, client) } : {}),
      connect_url: client.dashboardUrl(`/dashboard/apps/${encodeURIComponent(slug)}#connect`),
      next:
        "Ask the user to open connect_url and paste a key under \"Register this URL with Stripe or GitHub\": a Stripe restricted key " +
        "with Webhook Endpoints = Write, or a fine-grained GitHub token with Webhooks = Read and write. AnyHook registers the app's " +
        "inbound URL at the provider, saves the signing secret it yields and turns on signature verification. The key goes from the " +
        "user to AnyHook, never through this conversation, and is not stored. anyhook_events shows the first event once it is connected.",
    });
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

export async function handleCodeGet(input: { appSlug: string }, client: AnyHookClient) {
  try {
    return asTextContent(await client.getCode(input.appSlug));
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleCodeDeploy(
  input: { appSlug: string; code: string; schedule?: string | null; enabled?: boolean },
  client: AnyHookClient
) {
  try {
    // Never secrets: the user sets those in the dashboard, and the code reads them as env.NAME.
    return asTextContent(
      await client.putCode(input.appSlug, { code: input.code, schedule: input.schedule, enabled: input.enabled })
    );
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleCodeTest(input: { appSlug: string; event_id?: string; body?: unknown }, client: AnyHookClient) {
  try {
    return asTextContent(await client.testCode(input.appSlug, { event_id: input.event_id, body: input.body }));
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleUsage(_input: unknown, client: AnyHookClient) {
  try {
    return asTextContent(await client.usage());
  } catch (err) {
    return asApiError(err);
  }
}

export async function handleAppReplayFailed(
  input: { appSlug: string; since?: string; limit?: number },
  client: AnyHookClient
) {
  try {
    const result = await client.replayFailedForApp(input.appSlug, { since: input.since, limit: input.limit });
    // The API's own counts, as they are: `replayed: true` here once read as
    // success with nothing replayed, and hid `more` from the agent.
    return asTextContent({ appSlug: input.appSlug, ...(result as Record<string, unknown>) });
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
      return asErrorContent({ error: body?.error ?? `quickstart failed (${res.status})` });
    }
    return asTextContent({
      ...body,
      mcp_note:
        "Give the sender inbound_url. AnyHook keeps receiving after this process exits. " +
        "This session is connected: list deliveries with anyhook_events, then read one payload with anyhook_inspect. " +
        "During the trial, keep the api_key in your MCP client's secret configuration as ANYHOOK_API_KEY to resume. " +
        "Keep the key out of chat replies and sender configuration. Give the owner claim_url privately before expires_at " +
        "to keep the same URL beyond the 7-day trial. Claiming revokes trial keys by default. " +
        "After claiming, sign in to hosted MCP with the claiming account or configure a new key from that account.",
    });
  } catch (err) {
    return asApiError(err);
  }
}
