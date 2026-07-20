/**
 * Smoke tests for remote-mode tool handlers — exercise the contract
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
  handleAppsCreate,
  handleAppUndelivered,
  handleAppReplayFailed,
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
  it("returns the matching event from the list", async () => {
    const client = fakeClient({
      listEvents: vi.fn().mockResolvedValue({
        events: [
          { id: "a", source: "stripe" },
          { id: "b", source: "github" },
        ],
      }),
    });
    const result = await handleEventInspectRemote({ id: "b" }, client);
    expect(parse(result).source).toBe("github");
  });

  it("returns an error when the id is not in the latest 200 events", async () => {
    const client = fakeClient({
      listEvents: vi.fn().mockResolvedValue({ events: [{ id: "x", source: "stripe" }] }),
    });
    const result = await handleEventInspectRemote({ id: "missing" }, client);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing");
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

describe("handleAppUndelivered + handleAppReplayFailed", () => {
  it("lists undelivered events for an app", async () => {
    const client = fakeClient({
      listUndelivered: vi.fn().mockResolvedValue({ events: [{ id: "u1" }] }),
    });
    const result = await handleAppUndelivered({ appSlug: "billing", limit: 25 }, client);
    expect(client.listUndelivered).toHaveBeenCalledWith("billing", 25);
    expect(parse(result).events[0].id).toBe("u1");
  });

  it("bulk-replays failed events", async () => {
    const client = fakeClient({
      replayFailedForApp: vi.fn().mockResolvedValue({ queued: 7 }),
    });
    const result = await handleAppReplayFailed({ appSlug: "billing" }, client);
    expect(client.replayFailedForApp).toHaveBeenCalledWith("billing");
    expect(parse(result).appSlug).toBe("billing");
  });
});
