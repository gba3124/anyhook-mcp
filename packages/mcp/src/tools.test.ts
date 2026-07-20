import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@anyhook/core/store";
import {
  handleMock,
  handleVerify,
  handleEventsList,
  handleEventInspect,
  handleProviders,
  handleEventsSimulate,
} from "./tools";

function parseText(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

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
