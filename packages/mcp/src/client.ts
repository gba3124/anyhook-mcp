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
  destinations?: { url: string; signing_secret?: string }[];
  createdAt?: string;
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

  async replayEvent(id: string): Promise<unknown> {
    return this.request(`/api/v1/events/${encodeURIComponent(id)}/replay`, {
      method: "POST",
    });
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

  async listUndelivered(
    appSlug: string,
    limit?: number
  ): Promise<{ events: RemoteEvent[] }> {
    const qs = limit ? `?limit=${limit}` : "";
    return this.request(
      `/api/v1/apps/${encodeURIComponent(appSlug)}/events/undelivered${qs}`
    );
  }

  async replayFailedForApp(appSlug: string): Promise<unknown> {
    return this.request(
      `/api/v1/apps/${encodeURIComponent(appSlug)}/replay-failed`,
      { method: "POST" }
    );
  }
}
