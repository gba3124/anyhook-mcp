import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@anyhook/core/store";
import {
  handleMock,
  handleVerify,
  handleEventsList,
  handleEventInspect,
  handleProviders,
  handleEventsSimulate,
} from "./tools";
import { AnyHookApiError, type AnyHookClient } from "./client";

function parseText(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

describe("handleMock on the hosted server", () => {
  const input = { provider: "stripe" as const, event: "payment_intent.succeeded", targetUrl: "https://example.test/hook" };
  const account = { usage: async () => ({}) } as unknown as AnyHookClient;
  const stubFetch = () => {
    const sent = vi.fn(async () => new Response("x".repeat(20_000)));
    vi.stubGlobal("fetch", sent);
    return sent;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("sends nothing for a key the API refuses", async () => {
    const sent = stubFetch();
    const refused = { usage: async () => { throw new AnyHookApiError(401, "Invalid API key", { error: "Invalid API key" }); } } as unknown as AnyHookClient;
    const result = await handleMock(input, { client: refused, checkUrl: () => ({ valid: true }) });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toMatchObject({ status: 401, error: "Invalid API key" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("sends nothing to a URL the check refuses, or when there is no check", async () => {
    const sent = stubFetch();
    const refused = await handleMock(input, { client: account, checkUrl: () => ({ valid: false, reason: "Blocked hostname: localhost" }) });
    expect(parseText(refused)).toMatchObject({ detail: "Blocked hostname: localhost" });
    expect(parseText(refused).fix).toContain("npx -y anyhook-mcp");
    expect((await handleMock(input, { client: account })).isError).toBe(true);
    expect(sent).not.toHaveBeenCalled();
  });

  it("leaves a redirect alone and reads only part of a long answer", async () => {
    const sent = stubFetch();
    const result = await handleMock(input, { client: account, checkUrl: () => ({ valid: true }) });
    expect((sent.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
    expect(parseText(result).response.body).toHaveLength(10_000);
  });
});

describe("handleMock", () => {
  it("returns a Stripe request with valid signature", async () => {
    const result = await handleMock({ provider: "stripe", event: "payment_intent.succeeded" });
    expect(result.isError).toBeFalsy();
    const data = parseText(result);
    expect(data.method).toBe("POST");
    expect(data.headers["stripe-signature"]).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
  });

  it("returns an error for unknown event", async () => {
    const result = await handleMock({ provider: "stripe", event: "not.a.real.event" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown event");
  });
});

describe("handleVerify", () => {
  it("returns valid=true for a matching signature (round-trip via handleMock)", async () => {
    const mockResult = await handleMock({
      provider: "stripe",
      event: "payment_intent.succeeded",
      secret: "test_secret",
    });
    const mockData = parseText(mockResult);

    const verifyResult = await handleVerify({
      provider: "stripe",
      headers: mockData.headers,
      body: mockData.body,
      secret: "test_secret",
    });
    const verifyData = parseText(verifyResult);
    expect(verifyData.valid).toBe(true);
  });

  it("returns valid=false for wrong secret", async () => {
    const mockResult = await handleMock({
      provider: "stripe",
      event: "payment_intent.succeeded",
      secret: "right_secret",
    });
    const mockData = parseText(mockResult);

    const verifyResult = await handleVerify({
      provider: "stripe",
      headers: mockData.headers,
      body: mockData.body,
      secret: "wrong_secret",
    });
    const verifyData = parseText(verifyResult);
    expect(verifyData.valid).toBe(false);
  });
});

describe("handleProviders", () => {
  it("lists all supported providers with their events", async () => {
    const result = await handleProviders();
    const data = parseText(result);
    expect(data.providers.length).toBeGreaterThan(0);
    const stripe = data.providers.find((p: { provider: string }) => p.provider === "stripe");
    expect(stripe?.events).toContain("payment_intent.succeeded");
  });
});

describe("handleEventsSimulate + handleEventsList + handleEventInspect", () => {
  it("simulate inserts an event that list and inspect can read back", async () => {
    const store = createMemoryStore();

    const simulated = await handleEventsSimulate(
      { provider: "github", event: "pull_request.opened" },
      store
    );
    const simData = parseText(simulated);
    expect(simData.id).toBeDefined();
    expect(simData.source).toBe("github");

    const listResult = await handleEventsList({ source: "github" }, store);
    const listData = parseText(listResult);
    expect(listData.events.length).toBe(1);
    expect(listData.events[0].id).toBe(simData.id);

    const inspectResult = await handleEventInspect({ id: simData.id }, store);
    const inspectData = parseText(inspectResult);
    expect(inspectData.eventType).toBe("pull_request.opened");
    expect(inspectData.body).toContain("opened");
  });

  it("inspect returns an error for missing id", async () => {
    const store = createMemoryStore();
    const result = await handleEventInspect({ id: "nonexistent" }, store);
    expect(result.isError).toBe(true);
  });
});

describe("handleVerify without a scheme to check", () => {
  const verify = (provider: string) => handleVerify({ provider, headers: {}, body: "{}", secret: "x" });
  const parsed = (r: Awaited<ReturnType<typeof verify>>) => JSON.parse((r.content[0] as { text: string }).text);

  it("says generic was not checked instead of answering valid", async () => {
    expect(parsed(await verify("generic"))).toMatchObject({ valid: null, checked: false });
  });

  it("says what to check when a name has no scheme", async () => {
    const result = parsed(await verify("nonsense"));
    expect(result.valid).toBe(false);
    expect(result.detail).toContain("provider name");
  });
});
