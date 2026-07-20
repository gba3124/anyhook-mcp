import { describe, expect, it } from "vitest";
import {
  verifyWebhook,
  verifyWebhookOrThrow,
  verifyPayload,
  verifyPayloadOrThrow,
  parseSignatureHeader,
  WebhookVerificationError,
} from "./verify";
import { signWebhook } from "./testing";

const SECRET = "whsec_test_constant_secret_for_verify_unit_tests_aaaa";

function reqWith(headers: Record<string, string>, body: string): Request {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers,
    body,
  });
}

// ──────────────────────────────────────────────────────────────────────────

describe("parseSignatureHeader", () => {
  it("parses a single v1 signature", () => {
    const r = parseSignatureHeader("t=1716567890,v1=abc123");
    expect(r).toEqual({ timestamp: 1716567890, signatures: ["abc123"] });
  });

  it("parses multiple v1 signatures (key rotation)", () => {
    const r = parseSignatureHeader("t=1716567890,v1=aaa,v1=bbb,v1=ccc");
    expect(r?.signatures).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("tolerates whitespace around separators", () => {
    const r = parseSignatureHeader("  t=1716567890 , v1=abc123 ");
    expect(r).toEqual({ timestamp: 1716567890, signatures: ["abc123"] });
  });

  it("returns null when timestamp is missing", () => {
    expect(parseSignatureHeader("v1=abc123")).toBeNull();
  });

  it("returns null when no v1 signature is present", () => {
    expect(parseSignatureHeader("t=1716567890,v0=oldformat")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseSignatureHeader(null)).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("garbage")).toBeNull();
    expect(parseSignatureHeader("t=notanumber,v1=abc")).toBeNull();
  });

  it("rejects non-positive timestamps (defensive: never legitimately produced)", () => {
    expect(parseSignatureHeader("t=0,v1=abc")).toBeNull();
    expect(parseSignatureHeader("t=-1,v1=abc")).toBeNull();
  });
});

describe("verifyWebhook round-trip", () => {
  it("returns true for a freshly signed valid request", async () => {
    const body = '{"event":"payment_intent.succeeded","id":"pi_abc"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: body });
    const req = reqWith({ "Anyhook-Signature": header }, body);
    await expect(verifyWebhook(req, SECRET)).resolves.toBe(true);
  });

  it("does not consume the body — caller can still read it", async () => {
    const body = '{"hello":"world"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: body });
    const req = reqWith({ "Anyhook-Signature": header }, body);

    expect(await verifyWebhook(req, SECRET)).toBe(true);
    // The original body is still consumable by the caller.
    expect(await req.text()).toBe(body);
  });

  it("accepts any header casing — Headers.get() is case-insensitive", async () => {
    const body = "ping";
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: body });
    const req1 = reqWith({ "anyhook-signature": header }, body);
    const req2 = reqWith({ "ANYHOOK-SIGNATURE": header }, body);
    await expect(verifyWebhook(req1, SECRET)).resolves.toBe(true);
    await expect(verifyWebhook(req2, SECRET)).resolves.toBe(true);
  });

  it("returns false (does not throw) when the body has already been consumed", async () => {
    const body = "ping";
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: body });
    const req = reqWith({ "Anyhook-Signature": header }, body);
    await req.text(); // simulate framework eating the body first
    await expect(verifyWebhook(req, SECRET)).resolves.toBe(false);
  });
});

describe("verifyWebhook rejection paths", () => {
  it("rejects when no Anyhook-Signature header is present", async () => {
    const req = reqWith({}, "body");
    await expect(verifyWebhook(req, SECRET)).resolves.toBe(false);
  });

  it("rejects when the signature is computed from the wrong secret", async () => {
    const body = "body";
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: "wrong_secret", timestamp: ts, payload: body });
    const req = reqWith({ "Anyhook-Signature": header }, body);
    await expect(verifyWebhook(req, SECRET)).resolves.toBe(false);
  });

  it("rejects when the body has been tampered after signing", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: "original" });
    const req = reqWith({ "Anyhook-Signature": header }, "tampered");
    await expect(verifyWebhook(req, SECRET)).resolves.toBe(false);
  });

  it("rejects when the timestamp is older than the tolerance window", async () => {
    const now = 1_700_000_000;
    const tooOld = now - 600; // 10 minutes ago, default tolerance is 5
    const header = await signWebhook({ secret: SECRET, timestamp: tooOld, payload: "body" });
    const req = reqWith({ "Anyhook-Signature": header }, "body");
    await expect(verifyWebhook(req, SECRET, { now })).resolves.toBe(false);
  });

  it("rejects when the timestamp is too far in the future (clock skew)", async () => {
    const now = 1_700_000_000;
    const tooNew = now + 600;
    const header = await signWebhook({ secret: SECRET, timestamp: tooNew, payload: "body" });
    const req = reqWith({ "Anyhook-Signature": header }, "body");
    await expect(verifyWebhook(req, SECRET, { now })).resolves.toBe(false);
  });

  it("accepts a wider tolerance window when explicitly opted in", async () => {
    const now = 1_700_000_000;
    const ts = now - 3600; // an hour ago
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: "body" });
    const req = reqWith({ "Anyhook-Signature": header }, "body");
    await expect(
      verifyWebhook(req, SECRET, { now, tolerance: 7200 })
    ).resolves.toBe(true);
  });
});

describe("verifyWebhook key rotation", () => {
  it("accepts a request signed with one of multiple secrets", async () => {
    const body = "rotation-test";
    const ts = Math.floor(Date.now() / 1000);

    // Sign with the OLD secret but include both v1's (as the forwarder
    // would during a rotation window).
    const oldSecret = "whsec_old_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newSecret = SECRET;
    const oldSig = (await signWebhook({ secret: oldSecret, timestamp: ts, payload: body })).split(",v1=")[1];
    const newSig = (await signWebhook({ secret: newSecret, timestamp: ts, payload: body })).split(",v1=")[1];
    const header = `t=${ts},v1=${oldSig},v1=${newSig}`;

    const req = reqWith({ "Anyhook-Signature": header }, body);
    // Caller is on new secret — should still verify because one of the
    // v1 entries matches.
    await expect(verifyWebhook(req, newSecret)).resolves.toBe(true);
    // Caller still on old secret — should also verify.
    await expect(verifyWebhook(req, oldSecret)).resolves.toBe(true);
    // Caller on a totally unrelated secret — rejects.
    await expect(verifyWebhook(req, "whsec_unrelated_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))
      .resolves.toBe(false);
  });
});

describe("verifyPayload (low-level)", () => {
  it("verifies a string-body + header pair", async () => {
    const body = '{"k":"v"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: body });
    await expect(
      verifyPayload({ payload: body, header, secret: SECRET })
    ).resolves.toBe(true);
  });

  it("rejects when header is null/empty", async () => {
    await expect(
      verifyPayload({ payload: "x", header: null, secret: SECRET })
    ).resolves.toBe(false);
    await expect(
      verifyPayload({ payload: "x", header: "", secret: SECRET })
    ).resolves.toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Throwing variants
// ──────────────────────────────────────────────────────────────────────────

describe("verifyWebhookOrThrow", () => {
  it("returns the verified payload + timestamp on success", async () => {
    const body = '{"k":"v"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: body });
    const req = reqWith({ "Anyhook-Signature": header }, body);
    const result = await verifyWebhookOrThrow(req, SECRET);
    expect(result.payload).toBe(body);
    expect(result.timestamp).toBe(ts);
  });

  it("throws WebhookVerificationError with reason='missing-header' when no header", async () => {
    const req = reqWith({}, "body");
    await expect(verifyWebhookOrThrow(req, SECRET)).rejects.toMatchObject({
      name: "WebhookVerificationError",
      reason: "missing-header",
    });
  });

  it("throws reason='malformed-header' for garbage header", async () => {
    const req = reqWith({ "Anyhook-Signature": "totally-not-a-signature" }, "body");
    await expect(verifyWebhookOrThrow(req, SECRET)).rejects.toMatchObject({
      reason: "malformed-header",
    });
  });

  it("throws reason='timestamp-outside-tolerance' for old timestamps", async () => {
    const now = 1_700_000_000;
    const tooOld = now - 600;
    const header = await signWebhook({ secret: SECRET, timestamp: tooOld, payload: "x" });
    const req = reqWith({ "Anyhook-Signature": header }, "x");
    await expect(verifyWebhookOrThrow(req, SECRET, { now })).rejects.toMatchObject({
      reason: "timestamp-outside-tolerance",
    });
  });

  it("throws reason='signature-mismatch' when secret doesn't match", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: "wrong", timestamp: ts, payload: "x" });
    const req = reqWith({ "Anyhook-Signature": header }, "x");
    await expect(verifyWebhookOrThrow(req, SECRET)).rejects.toMatchObject({
      reason: "signature-mismatch",
    });
  });

  it("throws reason='body-already-consumed' when caller ate the body first", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: "x" });
    const req = reqWith({ "Anyhook-Signature": header }, "x");
    await req.text();
    await expect(verifyWebhookOrThrow(req, SECRET)).rejects.toMatchObject({
      reason: "body-already-consumed",
    });
  });

  it("WebhookVerificationError instances are usable with instanceof", async () => {
    const req = reqWith({}, "body");
    try {
      await verifyWebhookOrThrow(req, SECRET);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("verifyPayloadOrThrow", () => {
  it("returns the payload + timestamp on success", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: "x" });
    const result = await verifyPayloadOrThrow({ payload: "x", header, secret: SECRET });
    expect(result).toEqual({ payload: "x", timestamp: ts });
  });

  it("throws on null header", async () => {
    await expect(
      verifyPayloadOrThrow({ payload: "x", header: null, secret: SECRET })
    ).rejects.toMatchObject({ reason: "missing-header" });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Testing helper round-trip
// ──────────────────────────────────────────────────────────────────────────

describe("signWebhook (from anyhook-verify/testing)", () => {
  it("produces a header that verifyWebhook accepts", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await signWebhook({ secret: SECRET, timestamp: ts, payload: "ping" });
    expect(header).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
    const req = reqWith({ "Anyhook-Signature": header }, "ping");
    await expect(verifyWebhook(req, SECRET)).resolves.toBe(true);
  });

  it("produces a deterministic signature for the same inputs", async () => {
    const a = await signWebhook({ secret: SECRET, timestamp: 12345, payload: "x" });
    const b = await signWebhook({ secret: SECRET, timestamp: 12345, payload: "x" });
    expect(a).toBe(b);
  });
});
