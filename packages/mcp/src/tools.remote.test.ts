/**
 * Smoke tests for remote-mode tool handlers, exercise the contract
 * between the handler shape and a mocked AnyHookClient. We don't hit the
 * network here; we only assert that handlers extract args correctly,
 * dispatch to the right client method, and surface errors as MCP errors.
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleEventsListRemote,
  handleEventInspectRemote,
  handleEventReplay,
  handleAppsList,
  handleInbox,
  handleAppsCreate,
  handleAppUndelivered,
  handleAppReplayFailed,
  handleConnect,
  handleDestinationAdd,
  handleUsage,
  type ToolResult,
} from "./tools";
import { AnyHookApiError, type AnyHookClient } from "./client";

function fakeClient(overrides: Partial<AnyHookClient>): AnyHookClient {
  return overrides as unknown as AnyHookClient;
}

function parse(result: ToolResult) {
  return JSON.parse(result.content[0].text);
}

describe("handleEventsListRemote", () => {
  it("delegates to client.listEvents and wraps the result", async () => {
    const client = fakeClient({
      listEvents: vi
        .fn()
        .mockResolvedValue({ events: [{ id: "evt_1", source: "stripe" }], nextCursor: undefined }),
    });
    const result = await handleEventsListRemote(
      { appSlug: "billing", status: "failed", limit: 50 },
      client
    );
    expect(client.listEvents).toHaveBeenCalledWith({
      appSlug: "billing",
      status: "failed",
      limit: 50,
    });
    expect(parse(result).events[0].id).toBe("evt_1");
  });

  it("surfaces API errors via isError", async () => {
    const client = fakeClient({
      listEvents: vi.fn().mockRejectedValue(new AnyHookApiError(401, "Unauthorized")),
    });
    const result = await handleEventsListRemote({}, client);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
    expect(result.content[0].text).toContain("Unauthorized");
  });
});

describe("handleEventInspectRemote", () => {
  it("fetches the one event by id, with its payload", async () => {
    const client = fakeClient({
      getEvent: vi.fn().mockResolvedValue({
        event: { id: "b", source: "github", inboundBody: { action: "opened" } },
      }),
      listEvents: vi.fn(),
    });
    const result = await handleEventInspectRemote({ id: "b" }, client);
    expect(client.getEvent).toHaveBeenCalledWith("b");
    const event = parse(result);
    expect(event.source).toBe("github");
    expect(event.inboundBody.action).toBe("opened");
    // The whole point of the detail endpoint: no scanning a listing to find one row.
    expect(client.listEvents).not.toHaveBeenCalled();
  });

  it("turns a 404 into a pointer at anyhook_events rather than a raw API error", async () => {
    const client = fakeClient({
      getEvent: vi.fn().mockRejectedValue(new AnyHookApiError(404, "Event not found")),
    });
    const result = await handleEventInspectRemote({ id: "missing" }, client);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing");
    expect(result.content[0].text).toContain("anyhook_events");
  });

  it("surfaces non-404 API errors as-is", async () => {
    const client = fakeClient({
      getEvent: vi.fn().mockRejectedValue(new AnyHookApiError(401, "Unauthorized")),
    });
    const result = await handleEventInspectRemote({ id: "b" }, client);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
  });
});

describe("handleEventReplay", () => {
  it("calls client.replayEvent with the event id", async () => {
    const client = fakeClient({
      replayEvent: vi.fn().mockResolvedValue({ queued: true }),
    });
    const result = await handleEventReplay({ id: "evt_123" }, client);
    expect(client.replayEvent).toHaveBeenCalledWith("evt_123");
    const data = parse(result);
    expect(data.replayed).toBe(true);
    expect(data.id).toBe("evt_123");
  });
});

describe("handleInbox", () => {
  const apps = [
    { slug: "quickstart", inboxAddress: "u1.quickstart@anyhook.net", inboundUrl: "https://in.anyhook.net/u1/quickstart" },
    { slug: "stripe-prod", inboxAddress: "u1.stripe-prod@anyhook.net", inboundUrl: "https://in.anyhook.net/u1/stripe-prod" },
  ];

  it("defaults to the first app", async () => {
    const client = fakeClient({ listApps: vi.fn().mockResolvedValue({ apps }) });
    const data = parse(await handleInbox({}, client));
    expect(data.inbox_address).toBe("u1.quickstart@anyhook.net");
    expect(data.inbound_url).toBe("https://in.anyhook.net/u1/quickstart");
  });

  it("selects by slug", async () => {
    const client = fakeClient({ listApps: vi.fn().mockResolvedValue({ apps }) });
    const data = parse(await handleInbox({ app: "stripe-prod" }, client));
    expect(data.inbox_address).toBe("u1.stripe-prod@anyhook.net");
  });

  it("unknown slug → error listing what exists", async () => {
    const client = fakeClient({ listApps: vi.fn().mockResolvedValue({ apps }) });
    const data = parse(await handleInbox({ app: "nope" }, client));
    expect(data.error).toContain("nope");
    expect(data.available).toEqual(["quickstart", "stripe-prod"]);
  });

  it("no apps → points at quickstart", async () => {
    const client = fakeClient({ listApps: vi.fn().mockResolvedValue({ apps: [] }) });
    const data = parse(await handleInbox({}, client));
    expect(data.fix).toContain("anyhook_quickstart");
  });

  it("server without inbox support → says so instead of inventing an address", async () => {
    const client = fakeClient({ listApps: vi.fn().mockResolvedValue({ apps: [{ slug: "old" }] }) });
    const data = parse(await handleInbox({}, client));
    expect(data.error).toContain("does not expose inbox addresses");
  });
});

describe("handleAppsList + handleAppsCreate", () => {
  it("lists apps", async () => {
    const client = fakeClient({
      listApps: vi.fn().mockResolvedValue({ apps: [{ slug: "stripe-prod" }] }),
    });
    const result = await handleAppsList(undefined, client);
    expect(parse(result).apps[0].slug).toBe("stripe-prod");
  });

  it("creates an app", async () => {
    const client = fakeClient({
      createApp: vi.fn().mockResolvedValue({ slug: "new", inboundUrl: "https://in.anyhook.net/u/new" }),
    });
    const result = await handleAppsCreate(
      { name: "New", source: "stripe", destinations: [{ url: "https://example.com/hook" }] },
      client
    );
    expect(client.createApp).toHaveBeenCalledWith({
      name: "New",
      source: "stripe",
      destinations: [{ url: "https://example.com/hook" }],
    });
    expect(parse(result).inboundUrl).toBe("https://in.anyhook.net/u/new");
  });
});

describe("handleDestinationAdd", () => {
  it("adds the URL to the named app and passes the once-only secret through", async () => {
    const client = fakeClient({
      addDestination: vi.fn().mockResolvedValue({ added: true, signing_secret: "s" }),
    });
    const result = await handleDestinationAdd({ appSlug: "billing", url: "https://example.com/hook" }, client);
    expect(client.addDestination).toHaveBeenCalledWith("billing", "https://example.com/hook");
    expect(parse(result)).toEqual({ added: true, signing_secret: "s" });
  });

  it("keeps the API's fix when the plan refuses", async () => {
    const client = fakeClient({
      addDestination: vi.fn().mockRejectedValue(
        new AnyHookApiError(403, "destination_limit", { error: "destination_limit", fix: "Remove a destination." }),
      ),
    });
    const result = await handleDestinationAdd({ appSlug: "billing", url: "https://example.com/hook" }, client);
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ status: 403, error: "destination_limit", fix: "Remove a destination." });
  });
});

describe("handleAppUndelivered + handleAppReplayFailed", () => {
  it("lists undelivered events for an app", async () => {
    const client = fakeClient({
      listUndelivered: vi.fn().mockResolvedValue({ events: [{ id: "u1" }] }),
    });
    const result = await handleAppUndelivered({ appSlug: "billing", limit: 25 }, client);
    expect(client.listUndelivered).toHaveBeenCalledWith("billing", 25);
    expect(parse(result).events[0].id).toBe("u1");
  });

  it("bulk-replays failed events and passes on whether more are waiting", async () => {
    const client = fakeClient({
      replayFailedForApp: vi.fn().mockResolvedValue({ replayed: 50, events: [], skipped: [], more: true }),
    });
    const result = await handleAppReplayFailed({ appSlug: "billing", since: "2026-10-01T00:00:00Z", limit: 50 }, client);
    expect(client.replayFailedForApp).toHaveBeenCalledWith("billing", { since: "2026-10-01T00:00:00Z", limit: 50 });
    expect(parse(result)).toMatchObject({ appSlug: "billing", replayed: 50, more: true });
  });

  it("errors are one JSON shape with the API's fix kept", async () => {
    const client = fakeClient({
      replayFailedForApp: vi.fn().mockRejectedValue(
        new AnyHookApiError(429, "Rate limit exceeded", { error: "Rate limit exceeded", fix: "Wait 12s, then try again." }),
      ),
    });
    const result = await handleAppReplayFailed({ appSlug: "billing" }, client);
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ status: 429, error: "Rate limit exceeded", fix: "Wait 12s, then try again." });
  });
});

describe("handleConnect", () => {
  const key = ["rk", "live", "k".repeat(24)].join("_");

  it("sends the provider key as `key` with the app and target, and returns the result", async () => {
    const client = fakeClient({
      connect: vi.fn().mockResolvedValue({ connected: true, provider: "stripe", inboundUrl: "https://in.anyhook.net/acme/stripe" }),
    });
    const result = await handleConnect({ provider_key: key, appSlug: "payments" }, client);
    expect(client.connect).toHaveBeenCalledWith({ key, app: "payments", target: undefined });
    expect(parse(result)).toMatchObject({ connected: true, provider: "stripe" });
  });

  it("passes the route's error, detail and fix through so the agent can act on them", async () => {
    const client = fakeClient({
      connect: vi.fn().mockRejectedValue(
        new AnyHookApiError(403, "missing_permission", { error: "missing_permission", detail: "The key cannot manage webhook endpoints.", fix: "Webhook Endpoints = Write" })
      ),
    });
    const result = await handleConnect({ provider_key: key }, client);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ status: 403, error: "missing_permission", fix: "Webhook Endpoints = Write" });
    expect(result.content[0].text).not.toContain(key);
  });
});

describe("handleUsage", () => {
  it("returns the usage endpoint's answer as is", async () => {
    const client = fakeClient({ usage: vi.fn().mockResolvedValue({ plan: "pro", api_calls: { today: 3, limit: 1000 } }) });
    expect(parse(await handleUsage(undefined, client))).toMatchObject({ plan: "pro", api_calls: { today: 3 } });
  });

  it("a limit from any tool reaches the agent with its detail and fix", async () => {
    const client = fakeClient({
      listEvents: vi.fn().mockRejectedValue(
        new AnyHookApiError(429, "api_limit", { error: "api_limit", limit: 300, detail: "300 API calls a day on free", fix: "Wait for the reset" })
      ),
    });
    const result = await handleEventsListRemote({}, client);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ status: 429, error: "api_limit", limit: 300, fix: "Wait for the reset" });
  });
});
