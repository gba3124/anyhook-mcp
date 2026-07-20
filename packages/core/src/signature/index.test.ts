/**
 * Signature module — comprehensive test suite.
 * Covers all 19 provider verifiers, source detection, and PayPal helpers.
 */
import { describe, expect, it } from "vitest";
import { detectSource, verifySignature, crc32, extractSpkiFromCert } from "./index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function hmacHex(
  payload: string,
  secret: string,
  hash: "SHA-256" | "SHA-1"
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacBase64(
  payload: string,
  secret: string,
  hash: "SHA-256" | "SHA-1"
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return Buffer.from(new Uint8Array(signature)).toString("base64");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Source Detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("detectSource — all 14 providers + generic", () => {
  it("detects Stripe via stripe-signature header", () => {
    expect(detectSource(new Headers({ "stripe-signature": "t=123,v1=abc" }))).toBe("stripe");
  });

  it("detects GitHub via x-hub-signature-256 header", () => {
    expect(detectSource(new Headers({ "x-hub-signature-256": "sha256=abc" }))).toBe("github");
  });

  it("detects Shopify via x-shopify-hmac-sha256 header", () => {
    expect(detectSource(new Headers({ "x-shopify-hmac-sha256": "abc" }))).toBe("shopify");
  });

  it("detects Discord via x-signature-ed25519 header", () => {
    expect(detectSource(new Headers({ "x-signature-ed25519": "abc" }))).toBe("discord");
  });

  it("detects LemonSqueezy via x-signature + x-event-name headers", () => {
    expect(detectSource(new Headers({ "x-signature": "abc", "x-event-name": "order_created" }))).toBe("lemonsqueezy");
  });

  it("detects Paddle via paddle-signature header", () => {
    expect(detectSource(new Headers({ "paddle-signature": "ts=123;h1=abc" }))).toBe("paddle");
  });

  it("detects Sentry via sentry-hook-signature header", () => {
    expect(detectSource(new Headers({ "sentry-hook-signature": "abc" }))).toBe("sentry");
  });

  it("detects SendGrid via x-twilio-email-event-webhook-signature header", () => {
    expect(detectSource(new Headers({ "x-twilio-email-event-webhook-signature": "abc" }))).toBe("sendgrid");
  });

  it("detects Svix via svix-signature header", () => {
    expect(detectSource(new Headers({ "svix-signature": "v1,abc" }))).toBe("svix");
  });

  it("detects Svix via webhook-signature header (alternative)", () => {
    expect(detectSource(new Headers({ "webhook-signature": "v1,abc" }))).toBe("svix");
  });

  it("detects Slack via x-slack-signature header", () => {
    expect(detectSource(new Headers({ "x-slack-signature": "v0=abc" }))).toBe("slack");
  });

  it("detects Twilio via x-twilio-signature header", () => {
    expect(detectSource(new Headers({ "x-twilio-signature": "abc" }))).toBe("twilio");
  });

  it("detects Intercom via x-hub-signature (without x-hub-signature-256)", () => {
    expect(detectSource(new Headers({ "x-hub-signature": "sha1=abc" }))).toBe("intercom");
  });

  it("detects Linear via linear-signature header", () => {
    expect(detectSource(new Headers({ "linear-signature": "abc" }))).toBe("linear");
  });

  it("detects Vercel via x-vercel-signature header", () => {
    expect(detectSource(new Headers({ "x-vercel-signature": "abc" }))).toBe("vercel");
  });

  it("returns generic for unknown headers", () => {
    expect(detectSource(new Headers({ "content-type": "application/json" }))).toBe("generic");
  });

  it("prefers GitHub over Intercom when both x-hub-signature and x-hub-signature-256 present", () => {
    expect(
      detectSource(new Headers({
        "x-hub-signature-256": "sha256=abc",
        "x-hub-signature": "sha1=abc",
      }))
    ).toBe("github");
  });

  it("prefers LemonSqueezy over generic x-signature", () => {
    expect(detectSource(new Headers({ "x-signature": "abc" }))).toBe("generic");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Signature Verification — Happy Path
// ═══════════════════════════════════════════════════════════════════════════════

describe("verifySignature — all providers", () => {
  const body = JSON.stringify({ test: true });
  const secret = "test_webhook_secret";
  const url = "https://in.anyhook.net/demo/app";

  it("verifies LemonSqueezy HMAC-SHA256 signature", async () => {
    const sig = await hmacHex(body, secret, "SHA-256");
    const headers = new Headers({ "x-signature": sig, "x-event-name": "order_created" });
    expect(await verifySignature("lemonsqueezy", headers, body, secret, url)).toBe(true);
  });

  it("rejects invalid LemonSqueezy signature", async () => {
    const headers = new Headers({ "x-signature": "deadbeef", "x-event-name": "order_created" });
    expect(await verifySignature("lemonsqueezy", headers, body, secret, url)).toBe(false);
  });

  it("verifies Paddle signature with ts:payload format", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await hmacHex(`${ts}:${body}`, secret, "SHA-256");
    const headers = new Headers({ "paddle-signature": `ts=${ts};h1=${sig}` });
    expect(await verifySignature("paddle", headers, body, secret, url)).toBe(true);
  });

  it("rejects Paddle signature with expired timestamp (>30s)", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 60).toString();
    const sig = await hmacHex(`${ts}:${body}`, secret, "SHA-256");
    const headers = new Headers({ "paddle-signature": `ts=${ts};h1=${sig}` });
    expect(await verifySignature("paddle", headers, body, secret, url)).toBe(false);
  });

  it("verifies Sentry signature", async () => {
    const sig = await hmacHex(body, secret, "SHA-256");
    const headers = new Headers({ "sentry-hook-signature": sig });
    expect(await verifySignature("sentry", headers, body, secret, url)).toBe(true);
  });

  it("verifies Sentry signature with sha256= prefix", async () => {
    const sig = await hmacHex(body, secret, "SHA-256");
    const headers = new Headers({ "sentry-hook-signature": `sha256=${sig}` });
    expect(await verifySignature("sentry", headers, body, secret, url)).toBe(true);
  });

  it("verifies Twilio signature", async () => {
    const requestBody = "Body=hello&From=%2B123&To=%2B456";
    const joined = "BodyhelloFrom+123To+456";
    const sig = await hmacBase64(`${url}${joined}`, secret, "SHA-1");
    const headers = new Headers({ "x-twilio-signature": sig });
    expect(await verifySignature("twilio", headers, requestBody, secret, url)).toBe(true);
  });

  it("verifies Intercom signature", async () => {
    const sig = await hmacHex(body, secret, "SHA-1");
    const headers = new Headers({ "x-hub-signature": `sha1=${sig}` });
    expect(await verifySignature("intercom", headers, body, secret, url)).toBe(true);
  });

  it("verifies GitHub signature", async () => {
    const sig = await hmacHex(body, secret, "SHA-256");
    const headers = new Headers({ "x-hub-signature-256": `sha256=${sig}` });
    expect(await verifySignature("github", headers, body, secret, url)).toBe(true);
  });

  it("rejects GitHub signature with wrong prefix", async () => {
    const sig = await hmacHex(body, secret, "SHA-256");
    const headers = new Headers({ "x-hub-signature-256": sig });
    expect(await verifySignature("github", headers, body, secret, url)).toBe(false);
  });

  it("verifies Shopify signature", async () => {
    const sig = await hmacBase64(body, secret, "SHA-256");
    const headers = new Headers({ "x-shopify-hmac-sha256": sig });
    expect(await verifySignature("shopify", headers, body, secret, url)).toBe(true);
  });

  it("verifies Stripe signature", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await hmacHex(`${ts}.${body}`, secret, "SHA-256");
    const headers = new Headers({ "stripe-signature": `t=${ts},v1=${sig}` });
    expect(await verifySignature("stripe", headers, body, secret, url)).toBe(true);
  });

  it("rejects Stripe signature with expired timestamp (>5min)", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 400).toString();
    const sig = await hmacHex(`${ts}.${body}`, secret, "SHA-256");
    const headers = new Headers({ "stripe-signature": `t=${ts},v1=${sig}` });
    expect(await verifySignature("stripe", headers, body, secret, url)).toBe(false);
  });

  it("verifies Linear signature", async () => {
    const sig = await hmacHex(body, secret, "SHA-256");
    const headers = new Headers({ "linear-signature": sig });
    expect(await verifySignature("linear", headers, body, secret, url)).toBe(true);
  });

  it("verifies Vercel signature", async () => {
    const sig = await hmacHex(body, secret, "SHA-1");
    const headers = new Headers({ "x-vercel-signature": sig });
    expect(await verifySignature("vercel", headers, body, secret, url)).toBe(true);
  });

  it("verifies Slack signature", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const base = `v0:${ts}:${body}`;
    const sig = await hmacHex(base, secret, "SHA-256");
    const headers = new Headers({
      "x-slack-signature": `v0=${sig}`,
      "x-slack-request-timestamp": ts,
    });
    expect(await verifySignature("slack", headers, body, secret, url)).toBe(true);
  });

  it("rejects Slack signature with expired timestamp", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 400).toString();
    const base = `v0:${ts}:${body}`;
    const sig = await hmacHex(base, secret, "SHA-256");
    const headers = new Headers({
      "x-slack-signature": `v0=${sig}`,
      "x-slack-request-timestamp": ts,
    });
    expect(await verifySignature("slack", headers, body, secret, url)).toBe(false);
  });

  it("verifies Svix signature", async () => {
    const msgId = "msg_test123";
    const ts = Math.floor(Date.now() / 1000).toString();
    const signedPayload = `${msgId}.${ts}.${body}`;

    const rawSecretBytes = crypto.getRandomValues(new Uint8Array(24));
    const b64Secret = Buffer.from(rawSecretBytes).toString("base64");
    const svixSecret = `whsec_${b64Secret}`;

    const key = await crypto.subtle.importKey(
      "raw", rawSecretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]
    );
    const hmac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const sig = Buffer.from(new Uint8Array(hmac)).toString("base64");

    const headers = new Headers({
      "svix-id": msgId,
      "svix-timestamp": ts,
      "svix-signature": `v1,${sig}`,
    });
    expect(await verifySignature("svix", headers, body, svixSecret, url)).toBe(true);
  });

  it("verifies SendGrid ECDSA signature", async () => {
    const payload = JSON.stringify([{ event: "delivered" }]);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const data = `${timestamp}${payload}`;

    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      new TextEncoder().encode(data)
    );
    const sigB64 = Buffer.from(new Uint8Array(sig)).toString("base64");
    const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const pubB64 = Buffer.from(new Uint8Array(spki)).toString("base64");

    const headers = new Headers({
      "x-twilio-email-event-webhook-signature": sigB64,
      "x-twilio-email-event-webhook-timestamp": timestamp,
    });
    expect(await verifySignature("sendgrid", headers, payload, pubB64, url)).toBe(true);
  });

  it("verifies Discord Ed25519 signature", async () => {
    const payload = JSON.stringify({ type: 1 });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const data = `${timestamp}${payload}`;

    const keyPair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    );
    const sig = await crypto.subtle.sign(
      "Ed25519",
      keyPair.privateKey,
      new TextEncoder().encode(data)
    );
    const sigHex = Buffer.from(new Uint8Array(sig)).toString("hex");
    const rawPub = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const pubHex = Buffer.from(new Uint8Array(rawPub)).toString("hex");

    const headers = new Headers({
      "x-signature-ed25519": sigHex,
      "x-signature-timestamp": timestamp,
    });
    expect(await verifySignature("discord", headers, payload, pubHex, url)).toBe(true);
  });

  it("returns true for generic source (no verification needed)", async () => {
    const headers = new Headers({ "content-type": "application/json" });
    expect(await verifySignature("generic", headers, body, secret, url)).toBe(true);
  });

  it("normalizes case/whitespace so real providers still verify", async () => {
    const headers = new Headers({ "content-type": "application/json" });
    // Unknown/mis-cased/misspelled providers must FAIL closed, not report authentic.
    expect(await verifySignature("Stripe", new Headers(), body, secret, url)).toBe(false);
    expect(await verifySignature("totally-not-a-provider", headers, body, secret, url)).toBe(false);
    // But " GENERIC " normalizes to the known generic case (no-verify → true).
    expect(await verifySignature("  GENERIC  ", headers, body, secret, url)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Missing Header Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("verifySignature — missing header returns false", () => {
  const body = '{"test":true}';
  const secret = "test_secret";
  const url = "https://in.anyhook.net/demo/app";

  it("Stripe without stripe-signature header → false", async () => {
    expect(await verifySignature("stripe", new Headers(), body, secret, url)).toBe(false);
  });

  it("GitHub without x-hub-signature-256 header → false", async () => {
    expect(await verifySignature("github", new Headers(), body, secret, url)).toBe(false);
  });

  it("Shopify without x-shopify-hmac-sha256 header → false", async () => {
    expect(await verifySignature("shopify", new Headers(), body, secret, url)).toBe(false);
  });

  it("Slack without x-slack-signature header → false", async () => {
    expect(await verifySignature("slack", new Headers(), body, secret, url)).toBe(false);
  });

  it("Discord without x-signature-ed25519 header → false", async () => {
    expect(await verifySignature("discord", new Headers(), body, secret, url)).toBe(false);
  });

  it("Twilio without x-twilio-signature header → false", async () => {
    expect(await verifySignature("twilio", new Headers(), body, secret, url)).toBe(false);
  });

  it("Linear without linear-signature header → false", async () => {
    expect(await verifySignature("linear", new Headers(), body, secret, url)).toBe(false);
  });

  it("Vercel without x-vercel-signature header → false", async () => {
    expect(await verifySignature("vercel", new Headers(), body, secret, url)).toBe(false);
  });

  it("Intercom without x-hub-signature header → false", async () => {
    expect(await verifySignature("intercom", new Headers(), body, secret, url)).toBe(false);
  });

  it("Sentry without sentry-hook-signature header → false", async () => {
    expect(await verifySignature("sentry", new Headers(), body, secret, url)).toBe(false);
  });

  it("SendGrid without required headers → false", async () => {
    expect(await verifySignature("sendgrid", new Headers(), body, secret, url)).toBe(false);
  });

  it("Svix without svix-id/timestamp/signature → false", async () => {
    expect(await verifySignature("svix", new Headers(), body, secret, url)).toBe(false);
  });

  it("Paddle without paddle-signature → false", async () => {
    expect(await verifySignature("paddle", new Headers(), body, secret, url)).toBe(false);
  });

  it("LemonSqueezy without x-signature → false", async () => {
    expect(await verifySignature("lemonsqueezy", new Headers(), body, secret, url)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Clerk / Resend — same Svix UA, always 'svix' on auto-detect
// ═══════════════════════════════════════════════════════════════════════════════

describe("detectSource — Clerk/Resend indistinguishable from Svix on auto-detect", () => {
  it("svix-signature always returns svix (Clerk/Resend use identical Svix UA)", () => {
    expect(detectSource(new Headers({
      "svix-signature": "v1,abc",
      "user-agent": "Svix-Webhooks/1.4.1",
    }))).toBe("svix");
  });

  it("svix-signature with no user-agent returns svix", () => {
    expect(detectSource(new Headers({
      "svix-signature": "v1,abc",
    }))).toBe("svix");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HubSpot v3 + v2 + v1 fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe("verifySignature — HubSpot v3 + v2 fallback", () => {
  const body = JSON.stringify({ test: true });
  const secret = "hubspot_secret";
  const url = "https://in.anyhook.net/demo/app";

  it("verifies HubSpot v3 signature (preferred)", async () => {
    const ts = Date.now().toString();
    const signedPayload = `POST${url}${body}${ts}`;
    const sig = await hmacBase64(signedPayload, secret, "SHA-256");
    const headers = new Headers({
      "x-hubspot-signature-v3": sig,
      "x-hubspot-request-timestamp": ts,
    });
    expect(await verifySignature("hubspot", headers, body, secret, url)).toBe(true);
  });

  it("rejects HubSpot v3 with expired timestamp", async () => {
    const ts = (Date.now() - 600_000).toString();
    const signedPayload = `POST${url}${body}${ts}`;
    const sig = await hmacBase64(signedPayload, secret, "SHA-256");
    const headers = new Headers({
      "x-hubspot-signature-v3": sig,
      "x-hubspot-request-timestamp": ts,
    });
    expect(await verifySignature("hubspot", headers, body, secret, url)).toBe(false);
  });

  it("verifies HubSpot v2 signature (fallback, plain SHA-256)", async () => {
    const input = `${secret}POST${url}${body}`;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const sig = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
    const headers = new Headers({
      "x-hubspot-signature": sig,
    });
    expect(await verifySignature("hubspot", headers, body, secret, url)).toBe(true);
  });

  it("verifies HubSpot v1 signature (plain SHA-256, secret + body only)", async () => {
    const input = `${secret}${body}`;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const sig = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
    const headers = new Headers({
      "x-hubspot-signature": sig,
    });
    expect(await verifySignature("hubspot", headers, body, secret, url)).toBe(true);
  });

  it("rejects HubSpot with wrong signature", async () => {
    const headers = new Headers({
      "x-hubspot-signature": "deadbeef".repeat(8),
    });
    expect(await verifySignature("hubspot", headers, body, secret, url)).toBe(false);
  });

  it("rejects HubSpot with no signature headers at all", async () => {
    expect(await verifySignature("hubspot", new Headers(), body, secret, url)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PayPal helpers — CRC32 + SPKI extraction
// ═══════════════════════════════════════════════════════════════════════════════

describe("CRC32", () => {
  it("computes CRC32 of empty string", () => {
    expect(crc32("")).toBe(0x00000000);
  });

  it("computes CRC32 of '123456789'", () => {
    expect(crc32("123456789")).toBe(0xCBF43926);
  });

  it("computes CRC32 of a JSON webhook body", () => {
    const body = '{"event_type":"PAYMENT.CAPTURE.COMPLETED"}';
    const result = crc32(body);
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });
});

describe("extractSpkiFromCert", () => {
  it("extracts SPKI from a self-signed RSA cert and it can be imported", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    );
    const spkiBytes = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const spki = new Uint8Array(spkiBytes);

    function derSeq(contents: Uint8Array): Uint8Array {
      return derWrap(0x30, contents);
    }
    function derWrap(tag: number, data: Uint8Array): Uint8Array {
      const len = encodeLength(data.length);
      const result = new Uint8Array(1 + len.length + data.length);
      result[0] = tag;
      result.set(len, 1);
      result.set(data, 1 + len.length);
      return result;
    }
    function encodeLength(len: number): Uint8Array {
      if (len < 128) return new Uint8Array([len]);
      if (len < 256) return new Uint8Array([0x81, len]);
      return new Uint8Array([0x82, (len >> 8) & 0xFF, len & 0xFF]);
    }

    const version = derWrap(0xA0, derWrap(0x02, new Uint8Array([0x02])));
    const serial = derWrap(0x02, new Uint8Array([0x01]));
    const algo = derSeq(new Uint8Array([0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B]));
    const emptySeq = derSeq(new Uint8Array(0));
    const issuer = emptySeq;
    const validity = derSeq(new Uint8Array(0));
    const subject = emptySeq;

    const tbsContent = new Uint8Array([
      ...version, ...serial, ...algo, ...issuer, ...validity, ...subject, ...spki
    ]);
    const tbs = derSeq(tbsContent);
    const cert = derSeq(new Uint8Array([...tbs, ...algo, ...new Uint8Array([0x03, 0x01, 0x00])]));

    const extracted = extractSpkiFromCert(cert);
    expect(extracted).not.toBeNull();

    const importedKey = await crypto.subtle.importKey(
      "spki",
      extracted!,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    expect(importedKey.type).toBe("public");

    const data = new TextEncoder().encode("test message");
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, data);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", importedKey, signature, data);
    expect(valid).toBe(true);
  });

  it("returns null for garbage input", () => {
    expect(extractSpkiFromCert(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
  });
});

describe("verifySignature — PayPal", () => {
  const body = JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" });
  const webhookId = "WH-test-12345";
  const url = "https://in.anyhook.net/demo/app";

  it("rejects PayPal without required headers", async () => {
    expect(await verifySignature("paypal", new Headers(), body, webhookId, url)).toBe(false);
  });

  it("rejects PayPal with non-paypal cert URL (SSRF protection)", async () => {
    const headers = new Headers({
      "paypal-transmission-id": "tx-123",
      "paypal-transmission-time": "2026-04-15T00:00:00Z",
      "paypal-transmission-sig": "dGVzdA==",
      "paypal-cert-url": "https://evil.com/cert.pem",
      "paypal-auth-algo": "SHA256withRSA",
    });
    expect(await verifySignature("paypal", headers, body, webhookId, url)).toBe(false);
  });

  it("rejects PayPal with unsupported auth algo", async () => {
    const headers = new Headers({
      "paypal-transmission-id": "tx-123",
      "paypal-transmission-time": "2026-04-15T00:00:00Z",
      "paypal-transmission-sig": "dGVzdA==",
      "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-123",
      "paypal-auth-algo": "SHA512withRSA",
    });
    expect(await verifySignature("paypal", headers, body, webhookId, url)).toBe(false);
  });
});
