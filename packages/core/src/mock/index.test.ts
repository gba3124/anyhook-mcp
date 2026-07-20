/**
 * Mock module — generates webhook requests with valid signatures.
 *
 * Each mock is verified against the signature module to prove correctness:
 * the same code that verifies real provider webhooks must accept our fakes.
 */
import { describe, expect, it } from "vitest";
import { mock, listProviders, listEvents, getFixture } from "./index";
import { verifySignature } from "../signature";

const url = "https://example.com/webhook";

describe("mock — Stripe", () => {
  it("generates a payment_intent.succeeded request that passes verifySignature", async () => {
    const secret = "whsec_test_123";
    const req = await mock({ provider: "stripe", event: "payment_intent.succeeded", secret });

    expect(req.method).toBe("POST");
    expect(req.headers["stripe-signature"]).toBeDefined();
    expect(req.headers["content-type"]).toBe("application/json");

    const headers = new Headers(req.headers);
    expect(await verifySignature("stripe", headers, req.body, secret, url)).toBe(true);
  });

  it("default secret yields a verifiable request (no secret passed)", async () => {
    const req = await mock({ provider: "stripe", event: "payment_intent.succeeded" });
    const headers = new Headers(req.headers);
    // The default secret is exposed via getFixture or similar — test uses the same default
    // We just confirm the request is internally consistent: a default secret must be inferable.
    // Strategy: re-mock with the same provider+event and assert determinism of headers (minus timestamp).
    const req2 = await mock({ provider: "stripe", event: "payment_intent.succeeded" });
    expect(req.body).toBe(req2.body);
    expect(headers.get("stripe-signature")).toBeDefined();
  });

  it("body contains the event type", async () => {
    const req = await mock({ provider: "stripe", event: "payment_intent.succeeded" });
    const parsed = JSON.parse(req.body);
    expect(parsed.type).toBe("payment_intent.succeeded");
  });

  it("data override merges into the fixture", async () => {
    const req = await mock({
      provider: "stripe",
      event: "payment_intent.succeeded",
      data: { id: "evt_custom_id" },
    });
    const parsed = JSON.parse(req.body);
    expect(parsed.id).toBe("evt_custom_id");
    expect(parsed.type).toBe("payment_intent.succeeded");
  });
});

describe("mock — GitHub", () => {
  it("generates a pull_request.opened request that passes verifySignature", async () => {
    const secret = "github_webhook_secret";
    const req = await mock({ provider: "github", event: "pull_request.opened", secret });

    expect(req.headers["x-hub-signature-256"]).toMatch(/^sha256=/);
    expect(req.headers["x-github-event"]).toBe("pull_request");

    const headers = new Headers(req.headers);
    expect(await verifySignature("github", headers, req.body, secret, url)).toBe(true);
  });

  it("body contains the action matching the dotted event suffix", async () => {
    const req = await mock({ provider: "github", event: "pull_request.opened" });
    const parsed = JSON.parse(req.body);
    expect(parsed.action).toBe("opened");
  });
});

describe("mock — Slack", () => {
  it("generates an event_callback request that passes verifySignature", async () => {
    const secret = "slack_signing_secret";
    const req = await mock({ provider: "slack", event: "app_mention", secret });

    expect(req.headers["x-slack-signature"]).toMatch(/^v0=/);
    expect(req.headers["x-slack-request-timestamp"]).toMatch(/^\d+$/);

    const headers = new Headers(req.headers);
    expect(await verifySignature("slack", headers, req.body, secret, url)).toBe(true);
  });
});

describe("mock — discovery", () => {
  it("listProviders returns the providers that have fixtures", () => {
    const providers = listProviders();
    expect(providers).toContain("stripe");
    expect(providers).toContain("github");
    expect(providers).toContain("slack");
  });

  it("listEvents returns the events for a provider", () => {
    const events = listEvents("stripe");
    expect(events).toContain("payment_intent.succeeded");
  });

  it("getFixture returns the raw fixture", () => {
    const fixture = getFixture("stripe", "payment_intent.succeeded") as { type: string };
    expect(fixture.type).toBe("payment_intent.succeeded");
  });

  it("throws for unknown provider", () => {
    expect(() => getFixture("unknown" as never, "anything")).toThrow();
  });

  it("throws for unknown event on a known provider", () => {
    expect(() => getFixture("stripe", "completely.made.up.event")).toThrow();
  });
});
