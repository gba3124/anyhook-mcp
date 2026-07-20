/**
 * Mock module — generate webhook requests with valid signatures.
 *
 * Today supports Stripe, GitHub, and Slack. Adding a provider is two files:
 * a fixture map and a signer. The same code path that verifies real webhooks
 * (../signature) will accept anything mock() emits.
 */
import { stripeFixtures } from "./fixtures/stripe";
import { githubFixtures } from "./fixtures/github";
import { slackFixtures } from "./fixtures/slack";

export type MockProvider = "stripe" | "github" | "slack";

export interface MockOptions {
  provider: MockProvider;
  event: string;
  /** Deep-merged into the fixture before signing. */
  data?: Record<string, unknown>;
  /** Signing secret. Falls back to a deterministic default per provider. */
  secret?: string;
  /** Override the timestamp baked into signed payloads. Defaults to now. */
  timestamp?: Date;
}

export interface MockedRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_SECRETS: Record<MockProvider, string> = {
  stripe: "whsec_test_default",
  github: "github_test_default",
  slack: "slack_test_default",
};

const FIXTURES: Record<MockProvider, Record<string, unknown>> = {
  stripe: stripeFixtures,
  github: githubFixtures,
  slack: slackFixtures,
};

export function listProviders(): MockProvider[] {
  return Object.keys(FIXTURES) as MockProvider[];
}

export function listEvents(provider: MockProvider): string[] {
  return Object.keys(FIXTURES[provider] ?? {});
}

export function getFixture(provider: MockProvider, event: string): unknown {
  const providerFixtures = FIXTURES[provider];
  if (!providerFixtures) throw new Error(`Unknown provider: ${provider}`);
  const fixture = providerFixtures[event];
  if (!fixture) throw new Error(`Unknown event '${event}' for provider '${provider}'`);
  return fixture;
}

export async function mock(opts: MockOptions): Promise<MockedRequest> {
  const fixture = getFixture(opts.provider, opts.event) as Record<string, unknown>;
  const secret = opts.secret ?? DEFAULT_SECRETS[opts.provider];
  const ts = opts.timestamp ?? new Date();

  const merged = deepMerge(fixture, opts.data ?? {});
  const body = JSON.stringify(merged);

  switch (opts.provider) {
    case "stripe":
      return signStripe(body, secret, ts);
    case "github":
      return signGithub(body, secret, opts.event);
    case "slack":
      return signSlack(body, secret, ts);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const existing = result[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      existing && typeof existing === "object" && !Array.isArray(existing)
    ) {
      result[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

async function hmacHex(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ────────────────────────────────────────────────────────────────────────────
// Per-provider signers
// ────────────────────────────────────────────────────────────────────────────

async function signStripe(body: string, secret: string, timestamp: Date): Promise<MockedRequest> {
  const ts = Math.floor(timestamp.getTime() / 1000).toString();
  const hex = await hmacHex(`${ts}.${body}`, secret);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${ts},v1=${hex}`,
    },
    body,
  };
}

async function signGithub(body: string, secret: string, event: string): Promise<MockedRequest> {
  const hex = await hmacHex(body, secret);
  // event is e.g. 'pull_request.opened' → header gets 'pull_request'
  const resourceName = event.includes(".") ? event.split(".")[0] : event;
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": resourceName,
      "x-hub-signature-256": `sha256=${hex}`,
      "x-github-delivery": crypto.randomUUID(),
    },
    body,
  };
}

async function signSlack(body: string, secret: string, timestamp: Date): Promise<MockedRequest> {
  const ts = Math.floor(timestamp.getTime() / 1000).toString();
  const hex = await hmacHex(`v0:${ts}:${body}`, secret);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": `v0=${hex}`,
    },
    body,
  };
}
