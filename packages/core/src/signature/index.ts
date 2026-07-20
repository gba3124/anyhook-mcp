/**
 * Signature verification for 19 webhook providers.
 *
 * All verifiers use Web Crypto API (crypto.subtle) so they run unchanged in
 * Node 20+, Cloudflare Workers, Bun, and Deno.
 *
 * Public surface:
 *   - detectSource(headers): auto-detect provider from request headers
 *   - verifySignature(source, headers, body, secret, requestUrl): true/false
 *   - crc32(str): IEEE 802.3 CRC32 (PayPal helper)
 *   - extractSpkiFromCert(der): SPKI bytes from X.509 cert (PayPal helper)
 */

export type Provider =
  | "stripe"
  | "github"
  | "shopify"
  | "lemonsqueezy"
  | "paddle"
  | "sentry"
  | "sendgrid"
  | "svix"
  | "clerk"
  | "resend"
  | "slack"
  | "twilio"
  | "intercom"
  | "linear"
  | "vercel"
  | "discord"
  | "hubspot"
  | "woocommerce"
  | "paypal"
  | "generic";

// ──────────────────────────────────────────────────────────────────────────────
// Provider auto-detection
// ──────────────────────────────────────────────────────────────────────────────

export function detectSource(headers: Headers): string {
  if (headers.get("stripe-signature")) return "stripe";
  if (headers.get("x-hub-signature-256")) return "github";
  if (headers.get("x-signature") && headers.get("x-event-name")) return "lemonsqueezy";
  if (headers.get("paddle-signature")) return "paddle";
  if (headers.get("sentry-hook-signature")) return "sentry";
  if (headers.get("x-twilio-email-event-webhook-signature")) return "sendgrid";
  if (headers.get("x-shopify-hmac-sha256")) return "shopify";
  if (headers.get("x-hubspot-signature-v3") || headers.get("x-hubspot-signature")) return "hubspot";
  if (headers.get("x-wc-webhook-signature")) return "woocommerce";
  if (headers.get("paypal-transmission-sig")) return "paypal";
  // Clerk and Resend both use Svix infra with identical headers (UA = "Svix-Webhooks/x.y.z").
  // Auto-detect cannot distinguish them — all return 'svix'. Users should explicitly set source to 'clerk' or 'resend'.
  if (headers.get("svix-signature") || headers.get("webhook-signature")) return "svix";
  if (headers.get("x-slack-signature")) return "slack";
  if (headers.get("x-twilio-signature")) return "twilio";
  if (headers.get("x-signature-ed25519")) return "discord";
  if (headers.get("x-hub-signature") && !headers.get("x-hub-signature-256")) return "intercom";
  if (headers.get("linear-signature")) return "linear";
  if (headers.get("x-vercel-signature")) return "vercel";
  return "generic";
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Constant-time string equality. We can't use Node's `crypto.timingSafeEqual`
 * because this module runs in Cloudflare Workers (Edge) as well as Node — the
 * Edge runtime exposes Web Crypto but not the Node crypto module.
 *
 * Implementation: convert both strings to UTF-8 bytes and XOR-accumulate.
 * Byte-level comparison is closer to what Node's `timingSafeEqual` does
 * internally and gives V8's JIT less room to optimise into a short-circuit
 * (the length check itself is acceptable to leak — signature hash lengths
 * are fixed by algorithm and public).
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

function toBase64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function hexToBytes(hex: string): ArrayBuffer | null {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) return null;
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    out[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return out.buffer as ArrayBuffer;
}

function pemOrBase64ToBytes(secret: string): ArrayBuffer {
  const trimmed = secret.trim();
  let base64 = trimmed.includes("BEGIN PUBLIC KEY")
    ? trimmed
        .replace(/-----BEGIN PUBLIC KEY-----/g, "")
        .replace(/-----END PUBLIC KEY-----/g, "")
        .replace(/\s+/g, "")
    : trimmed.replace(/\s+/g, "");
  base64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) base64 += "=";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

function decodeSvixSecret(secret: string): ArrayBuffer {
  const normalized = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return pemOrBase64ToBytes(normalized);
}

function parseSignaturePairs(sigHeader: string): { timestamp: string | null; signatures: string[] } {
  const tokens = sigHeader.split(/[;, ]+/).map((t) => t.trim()).filter(Boolean);
  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx === -1) continue;
    const key = token.slice(0, idx).toLowerCase();
    const value = token.slice(idx + 1);
    if ((key === "ts" || key === "t") && !timestamp) timestamp = value;
    if (key === "h1" || key === "v1") signatures.push(value.toLowerCase());
  }
  return { timestamp, signatures };
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-provider verifiers
// ──────────────────────────────────────────────────────────────────────────────

async function verifyStripe(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const parts = sigHeader.split(",");
  let t = "";
  const v1Values: string[] = [];
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx);
    const val = part.slice(eqIdx + 1);
    if (key === "t") t = val;
    if (key === "v1") v1Values.push(val);
  }
  if (!t || v1Values.length === 0) return false;

  const tolerance = 300; // 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(t)) > tolerance) return false;

  const signedPayload = `${t}.${payload}`;
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
    const hexSignature = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return v1Values.some((v1) => timingSafeEqual(hexSignature, v1));
  } catch {
    return false;
  }
}

async function verifyGithub(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  if (!sigHeader.startsWith("sha256=")) return false;
  const expectedSig = sigHeader.slice(7);
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hexSignature = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(hexSignature, expectedSig);
  } catch {
    return false;
  }
}

async function verifyShopify(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return timingSafeEqual(toBase64FromBytes(new Uint8Array(signature)), sigHeader);
  } catch {
    return false;
  }
}

async function verifyLinear(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(hex, sigHeader);
  } catch {
    return false;
  }
}

async function verifyVercel(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-1" },
      false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(hex, sigHeader);
  } catch {
    return false;
  }
}

async function verifySvix(payload: string, headers: Headers, secret: string): Promise<boolean> {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const signature = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return false;

  const signedPayload = `${id}.${timestamp}.${payload}`;
  const expectedSignatures = signature
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const sections = part.split(",");
      return sections.length === 2 ? sections[1] : "";
    })
    .filter(Boolean);
  if (expectedSignatures.length === 0) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      decodeSvixSecret(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const hmac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const calculated = toBase64FromBytes(new Uint8Array(hmac));
    return expectedSignatures.some((candidate) => timingSafeEqual(calculated, candidate));
  } catch {
    return false;
  }
}

async function verifySlack(payload: string, headers: Headers, secret: string): Promise<boolean> {
  const sigHeader = headers.get("x-slack-signature");
  const timestamp = headers.get("x-slack-request-timestamp");
  if (!sigHeader || !timestamp) return false;
  if (!sigHeader.startsWith("v0=")) return false;

  const toleranceSeconds = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceSeconds) return false;

  const base = `v0:${timestamp}:${payload}`;
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const hmac = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
    const hex = Array.from(new Uint8Array(hmac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(`v0=${hex}`, sigHeader);
  } catch {
    return false;
  }
}

async function verifyLemonSqueezy(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const normalized = sigHeader.trim().toLowerCase();
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const hmac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(hmac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(hex, normalized);
  } catch {
    return false;
  }
}

async function verifyPaddle(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const { timestamp, signatures } = parseSignaturePairs(sigHeader);
  if (!timestamp || signatures.length === 0) return false;

  const ts = parseInt(timestamp, 10);
  // Paddle SDK default is 5s; we use 30s to account for network jitter at the edge
  const toleranceSeconds = 30;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceSeconds) return false;

  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    // Paddle docs specify colon separator; try period as well for robustness
    const candidates = [`${timestamp}:${payload}`, `${timestamp}.${payload}`];
    for (const candidate of candidates) {
      const hmac = await crypto.subtle.sign("HMAC", key, encoder.encode(candidate));
      const hex = Array.from(new Uint8Array(hmac))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (signatures.some((sig) => timingSafeEqual(hex, sig))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function verifySentry(payload: string, headers: Headers, secret: string): Promise<boolean> {
  const sigHeader = headers.get("sentry-hook-signature");
  if (!sigHeader) return false;
  // Sentry signs HMAC-SHA256 of the raw body only (timestamp is NOT included)
  const normalized = sigHeader.toLowerCase().replace(/^sha256=/, "");

  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const hmac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(hmac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(hex, normalized);
  } catch {
    return false;
  }
}

async function verifyTwilio(payload: string, headers: Headers, secret: string, requestUrl: string): Promise<boolean> {
  const sigHeader = headers.get("x-twilio-signature");
  if (!sigHeader) return false;

  const url = new URL(requestUrl);
  const withQuery = url.toString();
  const withoutQuery = `${url.origin}${url.pathname}`;

  const params = new URLSearchParams(payload);
  const hasPairs = payload.includes("=");
  const sortedKeys = hasPairs ? Array.from(params.keys()).sort() : [];

  const baseStrings: string[] = [withQuery, withoutQuery];
  if (sortedKeys.length > 0) {
    const joined = sortedKeys.map((key) => `${key}${params.get(key) ?? ""}`).join("");
    baseStrings.push(`${withQuery}${joined}`);
    baseStrings.push(`${withoutQuery}${joined}`);
  }

  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    for (const base of baseStrings) {
      const hmac = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
      const calculated = toBase64FromBytes(new Uint8Array(hmac));
      if (timingSafeEqual(calculated, sigHeader)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function verifyIntercom(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  const normalized = sigHeader.startsWith("sha1=") ? sigHeader.slice(5) : sigHeader;
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const hmac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(hmac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return timingSafeEqual(hex, normalized);
  } catch {
    return false;
  }
}

async function verifySendGrid(payload: string, headers: Headers, publicKeySecret: string): Promise<boolean> {
  const sigHeader = headers.get("x-twilio-email-event-webhook-signature");
  const timestamp = headers.get("x-twilio-email-event-webhook-timestamp");
  if (!sigHeader || !timestamp) return false;

  try {
    const keyBytes = pemOrBase64ToBytes(publicKeySecret);
    const key = await crypto.subtle.importKey(
      "spki",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const signature = Uint8Array.from(atob(sigHeader), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(`${timestamp}${payload}`);
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature.buffer as ArrayBuffer,
      data
    );
  } catch {
    return false;
  }
}

async function verifyDiscord(payload: string, headers: Headers, publicKeyHex: string): Promise<boolean> {
  const sigHeader = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  if (!sigHeader || !timestamp) return false;

  const keyBytes = hexToBytes(publicKeyHex);
  const sigBytes = hexToBytes(sigHeader);
  if (!keyBytes || !sigBytes) return false;

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(`${timestamp}${payload}`);
    return crypto.subtle.verify("Ed25519", key, sigBytes, data);
  } catch {
    return false;
  }
}

async function verifyHubSpot(
  payload: string,
  headers: Headers,
  secret: string,
  requestUrl: string
): Promise<boolean> {
  // Try v3 first (preferred), then fall back to v2, then v1
  const v3Sig = headers.get("x-hubspot-signature-v3");
  const timestamp = headers.get("x-hubspot-request-timestamp");

  const encoder = new TextEncoder();

  // v3: HMAC-SHA256 of (method + url + body + timestamp), base64 output
  if (v3Sig && timestamp) {
    const ts = parseInt(timestamp, 10);
    const now = Date.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > 300_000) return false;
    try {
      const key = await crypto.subtle.importKey(
        "raw", encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const decodedUrl = decodeURI(requestUrl);
      const signedPayload = `POST${decodedUrl}${payload}${timestamp}`;
      const hmac = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
      const calculated = toBase64FromBytes(new Uint8Array(hmac));
      return timingSafeEqual(calculated, v3Sig);
    } catch { return false; }
  }

  // v2: plain SHA-256 hash of (secret + method + url + body), hex output
  // v1: plain SHA-256 hash of (secret + body), hex output
  const legacySig = headers.get("x-hubspot-signature");
  if (legacySig) {
    try {
      const v2Input = `${secret}POST${requestUrl}${payload}`;
      const v2Hash = await crypto.subtle.digest("SHA-256", encoder.encode(v2Input));
      const v2Hex = Array.from(new Uint8Array(v2Hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (timingSafeEqual(v2Hex, legacySig)) return true;

      const v1Input = `${secret}${payload}`;
      const v1Hash = await crypto.subtle.digest("SHA-256", encoder.encode(v1Input));
      const v1Hex = Array.from(new Uint8Array(v1Hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
      return timingSafeEqual(v1Hex, legacySig);
    } catch { return false; }
  }
  return false;
}

async function verifyWooCommerce(
  payload: string,
  sigHeader: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const hmac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return timingSafeEqual(toBase64FromBytes(new Uint8Array(hmac)), sigHeader);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// PayPal — RSA-SHA256 with cert fetch + SPKI extraction
// ──────────────────────────────────────────────────────────────────────────────

// CRC32 lookup table (IEEE 802.3 polynomial)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

export function crc32(str: string): number {
  const bytes = new TextEncoder().encode(str);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const paypalCertCache = new Map<string, string>();

async function fetchPayPalCert(certUrl: string): Promise<string | null> {
  try {
    const url = new URL(certUrl);
    if (
      !url.hostname.endsWith(".paypal.com") &&
      !url.hostname.endsWith(".symantec.com") &&
      !url.hostname.endsWith(".verisign.com")
    ) {
      return null;
    }
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }

  const cached = paypalCertCache.get(certUrl);
  if (cached) return cached;

  try {
    const res = await fetch(certUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const pem = await res.text();
    paypalCertCache.set(certUrl, pem);
    return pem;
  } catch {
    return null;
  }
}

function pemToBytes(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Extract SubjectPublicKeyInfo (SPKI) from a DER-encoded X.509 certificate.
 * Minimal ASN.1 parser — only traverses the structure needed to reach SPKI.
 */
export function extractSpkiFromCert(der: Uint8Array): ArrayBuffer | null {
  let offset = 0;

  function readTag(): { tag: number; constructed: boolean; length: number; headerLen: number } | null {
    if (offset >= der.length) return null;
    const tag = der[offset++];
    const constructed = (tag & 0x20) !== 0;
    if (offset >= der.length) return null;
    let length = der[offset++];
    let headerLen = 2;
    if (length & 0x80) {
      const numBytes = length & 0x7F;
      length = 0;
      for (let i = 0; i < numBytes; i++) {
        if (offset >= der.length) return null;
        length = (length << 8) | der[offset++];
        headerLen++;
      }
    }
    return { tag: tag & 0x1F, constructed, length, headerLen };
  }

  function skipElement(): boolean {
    const saved = offset;
    const info = readTag();
    if (!info) { offset = saved; return false; }
    offset += info.length;
    return offset <= der.length;
  }

  try {
    const cert = readTag();
    if (!cert || cert.tag !== 0x10) return null;

    const tbs = readTag();
    if (!tbs || tbs.tag !== 0x10) return null;

    const peekByte = der[offset];
    if (peekByte === 0xA0) skipElement(); // version

    skipElement(); // serialNumber
    skipElement(); // signature algorithm
    skipElement(); // issuer
    skipElement(); // validity
    skipElement(); // subject

    const spkiStart = offset;
    const spki = readTag();
    if (!spki || spki.tag !== 0x10) return null;
    const spkiEnd = offset + spki.length;

    return der.slice(spkiStart, spkiEnd).buffer as ArrayBuffer;
  } catch {
    return null;
  }
}

async function verifyPayPal(
  body: string,
  headers: Headers,
  webhookId: string
): Promise<boolean> {
  const transmissionId = headers.get("paypal-transmission-id");
  const transmissionTime = headers.get("paypal-transmission-time");
  const transmissionSig = headers.get("paypal-transmission-sig");
  const certUrl = headers.get("paypal-cert-url");
  const authAlgo = headers.get("paypal-auth-algo") ?? "SHA256withRSA";

  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl) return false;
  if (authAlgo !== "SHA256withRSA") return false;

  const pem = await fetchPayPalCert(certUrl);
  if (!pem) return false;

  try {
    const expectedMessage = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(body)}`;

    const certDer = pemToBytes(pem);
    const spki = extractSpkiFromCert(certDer);
    if (!spki) return false;

    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = Uint8Array.from(atob(transmissionSig), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(expectedMessage);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, data);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Top-level verifySignature dispatcher
// ──────────────────────────────────────────────────────────────────────────────

export async function verifySignature(
  source: string,
  headers: Headers,
  body: string,
  secret: string,
  requestUrl: string
): Promise<boolean> {
  // Normalize so "Stripe" / "GITHUB" / " stripe " verify correctly instead of
  // falling through to the fail-closed default.
  switch (source.trim().toLowerCase()) {
    case "stripe": {
      const sig = headers.get("stripe-signature");
      return sig ? verifyStripe(body, sig, secret) : false;
    }
    case "github": {
      const sig = headers.get("x-hub-signature-256");
      return sig ? verifyGithub(body, sig, secret) : false;
    }
    case "shopify": {
      const sig = headers.get("x-shopify-hmac-sha256");
      return sig ? verifyShopify(body, sig, secret) : false;
    }
    case "lemonsqueezy": {
      const sig = headers.get("x-signature");
      return sig ? verifyLemonSqueezy(body, sig, secret) : false;
    }
    case "paddle": {
      const sig = headers.get("paddle-signature");
      return sig ? verifyPaddle(body, sig, secret) : false;
    }
    case "sentry":
      return verifySentry(body, headers, secret);
    case "svix":
    case "clerk":
    case "resend":
      return verifySvix(body, headers, secret);
    case "slack":
      return verifySlack(body, headers, secret);
    case "twilio":
      return verifyTwilio(body, headers, secret, requestUrl);
    case "sendgrid":
      return verifySendGrid(body, headers, secret);
    case "discord":
      return verifyDiscord(body, headers, secret);
    case "intercom": {
      const sig = headers.get("x-hub-signature");
      return sig ? verifyIntercom(body, sig, secret) : false;
    }
    case "linear": {
      const sig = headers.get("linear-signature");
      return sig ? verifyLinear(body, sig, secret) : false;
    }
    case "hubspot":
      return verifyHubSpot(body, headers, secret, requestUrl);
    case "woocommerce": {
      const sig = headers.get("x-wc-webhook-signature");
      return sig ? verifyWooCommerce(body, sig, secret) : false;
    }
    case "vercel": {
      const sig = headers.get("x-vercel-signature");
      return sig ? verifyVercel(body, sig, secret) : false;
    }
    case "paypal":
      return verifyPayPal(body, headers, secret);
    case "generic":
      return true; // generic provider has no signature scheme — nothing to verify
    default:
      // Unknown/misspelled/mis-cased provider. Fail closed: reporting an unverified
      // payload as authentic (the old `return true`) is a signature-bypass hole.
      return false;
  }
}
