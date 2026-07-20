/**
 * In-memory event store — used by CLI (default) and MCP for ephemeral inspection.
 */
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./index";
import type { NewEventInput } from "./index";

function sampleEvent(overrides: Partial<NewEventInput> = {}): NewEventInput {
  return {
    source: "stripe",
    eventType: "payment_intent.succeeded",
    method: "POST",
    path: "/webhook",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" },
    body: '{"type":"payment_intent.succeeded"}',
    bodyEncoding: "utf8",
    signature: { provider: "stripe", valid: true },
    ...overrides,
  };
}

describe("memory store — insert + get", () => {
  it("inserts an event and retrieves it by id", async () => {
    const store = createMemoryStore();
    const inserted = await store.insert(sampleEvent());

    expect(inserted.id).toBeDefined();
    expect(inserted.receivedAt).toBeInstanceOf(Date);
    expect(inserted.status).toBe("received");
    expect(inserted.delivery).toEqual([]);

    const fetched = await store.get(inserted.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(inserted.id);
    expect(fetched!.body).toBe('{"type":"payment_intent.succeeded"}');
  });

  it("get returns null for missing id", async () => {
    const store = createMemoryStore();
    expect(await store.get("nonexistent")).toBeNull();
  });
});

describe("memory store — list", () => {
  it("returns events in reverse chronological order (newest first)", async () => {
    const store = createMemoryStore();
    const e1 = await store.insert(sampleEvent({ eventType: "first" }));
    await new Promise((r) => setTimeout(r, 2));
    const e2 = await store.insert(sampleEvent({ eventType: "second" }));
    await new Promise((r) => setTimeout(r, 2));
    const e3 = await store.insert(sampleEvent({ eventType: "third" }));

    const { events } = await store.list();
    expect(events.map((e) => e.id)).toEqual([e3.id, e2.id, e1.id]);
  });

  it("respects the limit", async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 5; i++) await store.insert(sampleEvent());

    const { events } = await store.list({ limit: 2 });
    expect(events.length).toBe(2);
  });

  it("filters by source", async () => {
    const store = createMemoryStore();
    await store.insert(sampleEvent({ source: "stripe" }));
    await store.insert(sampleEvent({ source: "github" }));
    await store.insert(sampleEvent({ source: "stripe" }));

    const { events } = await store.list({ source: "stripe" });
    expect(events.length).toBe(2);
    expect(events.every((e) => e.source === "stripe")).toBe(true);
  });

  it("filters by status", async () => {
    const store = createMemoryStore();
    await store.insert(sampleEvent());
    const b = await store.insert(sampleEvent());
    await store.setStatus(b.id, "forwarded");

    const { events } = await store.list({ status: "forwarded" });
    expect(events.length).toBe(1);
    expect(events[0].id).toBe(b.id);
  });
});

describe("memory store — status and delivery mutations", () => {
  it("setStatus updates the status", async () => {
    const store = createMemoryStore();
    const e = await store.insert(sampleEvent());
    await store.setStatus(e.id, "forwarded");

    const fetched = await store.get(e.id);
    expect(fetched!.status).toBe("forwarded");
  });

  it("appendDelivery appends an attempt", async () => {
    const store = createMemoryStore();
    const e = await store.insert(sampleEvent());

    await store.appendDelivery(e.id, {
      attempt: 1,
      targetUrl: "http://localhost:3000/webhook",
      startedAt: new Date(),
      status: 200,
      responseHeaders: { "content-type": "text/plain" },
      responseBody: "ok",
      latencyMs: 42,
      error: null,
    });

    const fetched = await store.get(e.id);
    expect(fetched!.delivery.length).toBe(1);
    expect(fetched!.delivery[0].status).toBe(200);
    expect(fetched!.delivery[0].latencyMs).toBe(42);
  });

  it("appendDelivery is a no-op for missing id", async () => {
    const store = createMemoryStore();
    await expect(
      store.appendDelivery("nonexistent", {
        attempt: 1,
        targetUrl: "x",
        startedAt: new Date(),
        status: 200,
        responseHeaders: {},
        responseBody: "",
        latencyMs: 0,
        error: null,
      })
    ).resolves.toBeUndefined();
  });
});

describe("memory store — clear", () => {
  it("clear() removes all events and returns count", async () => {
    const store = createMemoryStore();
    await store.insert(sampleEvent());
    await store.insert(sampleEvent());

    const deleted = await store.clear();
    expect(deleted).toBe(2);

    const { events } = await store.list();
    expect(events.length).toBe(0);
  });
});

describe("memory store — maxEvents cap", () => {
  it("evicts oldest events when over the cap", async () => {
    const store = createMemoryStore({ maxEvents: 3 });
    const e1 = await store.insert(sampleEvent({ eventType: "first" }));
    const e2 = await store.insert(sampleEvent({ eventType: "second" }));
    const e3 = await store.insert(sampleEvent({ eventType: "third" }));
    const e4 = await store.insert(sampleEvent({ eventType: "fourth" }));

    const { events } = await store.list();
    expect(events.length).toBe(3);
    expect(events.map((e) => e.id)).toContain(e4.id);
    expect(events.map((e) => e.id)).toContain(e3.id);
    expect(events.map((e) => e.id)).toContain(e2.id);
    expect(events.map((e) => e.id)).not.toContain(e1.id);
  });
});

describe("memory store — tail", () => {
  it("tail emits events inserted after the iterator starts", async () => {
    const store = createMemoryStore();
    const received: string[] = [];

    const ctrl = new AbortController();
    const consumer = (async () => {
      for await (const e of store.tail({ signal: ctrl.signal })) {
        received.push(e.eventType ?? "");
        if (received.length >= 2) ctrl.abort();
      }
    })();

    // Give the iterator a tick to wire up
    await new Promise((r) => setTimeout(r, 5));
    await store.insert(sampleEvent({ eventType: "first" }));
    await store.insert(sampleEvent({ eventType: "second" }));

    await consumer;
    expect(received).toEqual(["first", "second"]);
  });

  it("tail with source filter only yields matching events", async () => {
    const store = createMemoryStore();
    const received: string[] = [];
    const ctrl = new AbortController();

    const consumer = (async () => {
      for await (const e of store.tail({ filter: { source: "github" }, signal: ctrl.signal })) {
        received.push(e.source ?? "");
        if (received.length >= 1) ctrl.abort();
      }
    })();

    await new Promise((r) => setTimeout(r, 5));
    await store.insert(sampleEvent({ source: "stripe" }));
    await store.insert(sampleEvent({ source: "github" }));

    await consumer;
    expect(received).toEqual(["github"]);
  });
});
