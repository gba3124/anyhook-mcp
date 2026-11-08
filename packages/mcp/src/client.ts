/**
 * Thin HTTP client to the AnyHook REST API.
 *
 * Wraps fetch with the Bearer auth header and a typed surface for the
 * endpoints the MCP tools call. Network errors and non-2xx responses
 * are normalised to a single thrown shape so tool handlers can format
 * them as MCP errors uniformly.
 */
import type { McpConfig } from "./config";
import { USER_AGENT } from "./config";

export class AnyHookApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown
  ) {
    super(message);
    this.name = "AnyHookApiError";
  }
}

export type RemoteEvent = {
  id: string;
  receivedAt: string;
  source: string;
  eventType: string;
  status: string;
  signatureValid?: boolean | null;
  deliveryAttempts?: number;
  outboundUrl?: string;
  latencyMs?: number | null;
};

export type RemoteApp = {
  id: string;
  slug: string;
  name: string;
  source: string;
  inboundUrl: string;
  /** The same app by email, {user-slug}.{app-slug}@anyhook.net. */
  inboxAddress?: string;
  /** Former slugs: each still routes here, so a provider left on one loses nothing. */
  previousSlugs?: string[];
  /** Inbound URLs built from previousSlugs. */
  legacyInboundUrls?: string[];
  destinations?: {
    url: string;
    enabled?: boolean;
    /**
     * Signing secrets are shown once, when the app is created or the secret is
     * rotated, and are redacted everywhere else. These two fields are what a
     * listing returns; rotate to obtain a new secret in plaintext.
     */
    has_signing_secret?: boolean;
    signing_secret_hint?: string;
  }[];
  createdAt?: string;
};

/** What POST /api/v1/apps/{slug}/listen answers. */
export type ListenSession = {
  inbound_url: string;
  /** wss URL for the relay, signed and good until connect_expires_at (unix seconds). */
  connect_url: string;
  connect_expires_at: number;
  /** The app's other enabled destinations, which keep getting every event. */
  other_destinations: number;
  /** Set on a keyless account, which is deleted at expires_at unless claimed. */
  temporary: { expires_at: string; claim_url: string } | null;
};

export class AnyHookClient {
  constructor(private readonly cfg: McpConfig) {
    if (!cfg.apiKey) {
      throw new Error("AnyHookClient requires ANYHOOK_API_KEY");
    }
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const url = `${this.cfg.apiBase}${path}`;
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${this.cfg.apiKey}`,
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetch(url, { ...init, headers });
    } catch (err) {
      throw new AnyHookApiError(
        0,
        `Network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const msg =
        (parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status} ${res.statusText}`) || `HTTP ${res.status}`;
      throw new AnyHookApiError(res.status, msg, parsed);
    }

    return parsed as T;
  }

  async listEvents(params: {
    appSlug?: string;
    status?: string;
    limit?: number;
  }): Promise<{ events: RemoteEvent[]; nextCursor?: string }> {
    const qs = new URLSearchParams();
    if (params.appSlug) qs.set("app_slug", params.appSlug);
    if (params.status) qs.set("status", params.status);
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request(`/api/v1/events${suffix}`);
  }

  /**
   * One event with its payload. Listings omit bodies, so this is how a body is
   * read — previously inspect had to scan 200 listed events to find one.
   */
  async getEvent(id: string): Promise<{ event: RemoteEvent & Record<string, unknown> }> {
    return this.request(`/api/v1/events/${encodeURIComponent(id)}`);
  }

  async replayEvent(id: string): Promise<unknown> {
    return this.request(`/api/v1/events/${encodeURIComponent(id)}/replay`, {
      method: "POST",
    });
  }

  /** Put the app's `listen` destination in place and get a URL to connect to it. */
  async listen(appSlug: string): Promise<ListenSession> {
    return this.request(`/api/v1/apps/${encodeURIComponent(appSlug)}/listen`, { method: "POST" });
  }

  async listApps(): Promise<{ apps: RemoteApp[] }> {
    return this.request(`/api/v1/apps`);
  }

  async createApp(input: {
    name: string;
    source: string;
    destinations?: { url: string }[];
  }): Promise<RemoteApp> {
    return this.request(`/api/v1/apps`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Forward an existing app's events to one more URL; its other destinations stay as they are. */
  async addDestination(appSlug: string, url: string): Promise<unknown> {
    return this.request(`/api/v1/apps/${encodeURIComponent(appSlug)}/destinations`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  /**
   * Register an app's inbound URL with Stripe or GitHub using the provider's
   * own key, and save the signing secret it yields. The key rides this one
   * request; the API does not store it. Without `app`, a new app is created.
   */
  async connect(input: { key: string; app?: string; target?: string }): Promise<unknown> {
    return this.request(`/api/v1/connect`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listUndelivered(
    appSlug: string,
    limit?: number
  ): Promise<{ events: RemoteEvent[] }> {
    const qs = limit ? `?limit=${limit}` : "";
    return this.request(
      `/api/v1/apps/${encodeURIComponent(appSlug)}/events/undelivered${qs}`
    );
  }

  /** Failed events oldest first, received after `since` (default: 24 hours ago), at most `limit` (default 50, up to 100). */
  async replayFailedForApp(
    appSlug: string,
    opts: { since?: string; limit?: number } = {}
  ): Promise<unknown> {
    return this.request(
      `/api/v1/apps/${encodeURIComponent(appSlug)}/replay-failed`,
      { method: "POST", body: JSON.stringify(opts) }
    );
  }

  /** The app's code handler: its source, secret names and runs this month. */
  async getCode(appSlug: string): Promise<unknown> {
    return this.request(`/api/v1/apps/${encodeURIComponent(appSlug)}/code`);
  }

  /** Save the handler; secrets merge (null removes one), schedule is a cron or null. The app starts sending its events to it. */
  async putCode(
    appSlug: string,
    input: { code: string; secrets?: Record<string, string | null>; schedule?: string | null; enabled?: boolean }
  ): Promise<unknown> {
    return this.request(`/api/v1/apps/${encodeURIComponent(appSlug)}/code`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  /** Run the saved handler now on a stored event (latest by default) or a given body. */
  /** The plan's limits and this account's use of each: events, overage, compute, API calls, code runs. */
  async usage(): Promise<unknown> {
    return this.request(`/api/v1/usage`);
  }

  async testCode(appSlug: string, input: { event_id?: string; body?: unknown }): Promise<unknown> {
    return this.request(`/api/v1/apps/${encodeURIComponent(appSlug)}/code/test`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}
