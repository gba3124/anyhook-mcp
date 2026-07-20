/**
 * Core AnyHook-Signature verification.
 *
 * Wire format (Stripe-compatible):
 *
 *   Anyhook-Signature: t=<unix_seconds>,v1=<hex>[,v1=<hex>...]
 *
 * Multiple `v1=` entries support graceful key rotation — the destination
 * signs with the new secret AND the previous secret during the rotation
 * window so existing handlers don't need to redeploy at the same instant.
 *
 * Algorithm: HMAC-SHA256 over the string `"${timestamp}.${rawBody}"`.
 *
 * All crypto goes through Web Crypto so the same code runs in Node 20+,
 * Bun, Deno, Cloudflare Workers, and Vercel Edge without ifdefs.
 */

const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes — matches Stripe convention

export type VerifyOptions = {
  /**
   * Maximum allowed clock skew between the sender's timestamp and `now`,
   * in seconds. Requests outside this window are rejected to prevent
   * indefinite replay. Default: 300 (5 minutes).
   */
  tolerance?: number;
  /**
   * Override the wall clock, in UNIX **seconds** (not milliseconds) — useful for
   * tests and for handlers that deliberately operate in a different time domain.
   * Default: `Math.floor(Date.now() / 1000)`.
   */
  now?: number;
};

export type ParsedSignatureHeader = {
  timestamp: number;
  signatures: string[];
};

/** Result returned by the throwing API on success — the throwing variants
 * also expose the verified raw body and timestamp so the caller doesn't
 * have to read the body twice. */
export type VerifiedWebhook = {
  payload: string;
  timestamp: number;
};

/** Reason an Anyhook-Signature verification failed. Surfaced both as
 * the `reason` field on `WebhookVerificationError` and as the discriminant
 * in any future detailed-result API. */
export type VerifyFailureReason =
  | "missing-header"
  | "malformed-header"
  | "timestamp-outside-tolerance"
  | "signature-mismatch"
  | "body-already-consumed";

const REASON_MESSAGES: Record<VerifyFailureReason, string> = {
  "missing-header":
    "Anyhook-Signature header is missing from the request.",
  "malformed-header":
    "Anyhook-Signature header is present but could not be parsed (expected `t=<unix_seconds>,v1=<hex>`).",
  "timestamp-outside-tolerance":
    "Anyhook-Signature timestamp is outside the allowed tolerance window — possible replay attempt or significant clock skew.",
  "signature-mismatch":
    "Anyhook-Signature did not match the HMAC of the request body with the supplied secret.",
  "body-already-consumed":
    "Request body has already been consumed. Read the raw body yourself first and call verifyPayload({ payload, header, secret }) instead.",
};

/** Thrown by `verifyWebhookOrThrow` and `verifyPayloadOrThrow` when
 * verification fails. The `reason` field is a fixed string so callers
 * can branch on it without parsing the message text. */
export class WebhookVerificationError extends Error {
  public readonly reason: VerifyFailureReason;
  constructor(reason: VerifyFailureReason, message?: string) {
    super(message ?? REASON_MESSAGES[reason]);
    this.name = "WebhookVerificationError";
    this.reason = reason;
  }
}

/**
 * Parse a raw `Anyhook-Signature` header value into its parts.
 * Returns `null` if the value is malformed — never throws.
 */
export function parseSignatureHeader(
  value: string | null | undefined
): ParsedSignatureHeader | null {
  if (!value) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const segment of value.split(",")) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1).trim();
    if (key === "t") {
      const n = Number(val);
      // Reject NaN, infinities, and non-positive timestamps. Negative or
      // zero timestamps are never legitimately produced by the forwarder
      // and would only ever appear in crafted requests trying to confuse
      // the tolerance window.
      if (Number.isFinite(n) && n > 0) timestamp = n;
    } else if (key === "v1") {
      if (val.length > 0) signatures.push(val);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Verify a webhook delivery from AnyHook against a per-destination
 * signing secret.
 *
 * **Body consumption**: the Request body is read via `req.clone().text()`.
 * The original `req` is therefore still readable afterwards. **But**: if
 * the caller already consumed `req.body` (e.g. ran `await req.json()`
 * before calling this), the underlying ReadableStream is locked and
 * `clone()` would throw — in that case verifyWebhook returns `false` and
 * `verifyWebhookOrThrow` throws `WebhookVerificationError` with
 * `reason === "body-already-consumed"`. If your framework eats the body
 * for you, use {@link verifyPayload} with the raw body string instead.
 *
 * Returns `true` only if every check passes: header present, timestamp
 * inside the tolerance window, and at least one `v1` signature matches
 * the recomputed HMAC of `${timestamp}.${rawBody}`.
 */
export async function verifyWebhook(
  req: Request,
  secret: string,
  options: VerifyOptions = {}
): Promise<boolean> {
  if (req.bodyUsed) return false;
  // Headers.get() is case-insensitive per the Fetch spec, so the single
  // lookup handles `Anyhook-Signature`, `anyhook-signature`,
  // `ANYHOOK-SIGNATURE`, and any other casing automatically.
  const header = req.headers.get("anyhook-signature");
  const payload = await req.clone().text();
  return verifyPayload({
    payload,
    header,
    secret,
    tolerance: options.tolerance,
    now: options.now,
  });
}

/**
 * Throwing variant of {@link verifyWebhook}. Returns the verified raw
 * body + timestamp on success so the caller doesn't have to read the
 * body twice. Throws {@link WebhookVerificationError} on any failure,
 * with a typed `reason` field for branching.
 *
 * Use this style if you prefer Stripe-SDK-flavoured loud failure — it's
 * harder to accidentally skip a check (an unhandled rejection will fail
 * the request) than to forget an `if (!ok) return` after the boolean
 * variant.
 */
export async function verifyWebhookOrThrow(
  req: Request,
  secret: string,
  options: VerifyOptions = {}
): Promise<VerifiedWebhook> {
  if (req.bodyUsed) {
    throw new WebhookVerificationError("body-already-consumed");
  }
  const header = req.headers.get("anyhook-signature");
  const payload = await req.clone().text();
  return verifyPayloadOrThrow({
    payload,
    header,
    secret,
    tolerance: options.tolerance,
    now: options.now,
  });
}

/**
 * Same contract as {@link verifyWebhook} but works on a raw body string +
 * header value pair. Use this when your framework has already consumed
 * the body (Express raw body, Hono `c.req.text()`, etc.).
 */
export async function verifyPayload(input: {
  payload: string;
  header: string | null | undefined;
  secret: string;
  tolerance?: number;
  now?: number;
}): Promise<boolean> {
  const result = await verifyPayloadInner(input);
  return result.valid;
}

/**
 * Throwing variant of {@link verifyPayload} — see {@link verifyWebhookOrThrow}
 * for the contract.
 */
export async function verifyPayloadOrThrow(input: {
  payload: string;
  header: string | null | undefined;
  secret: string;
  tolerance?: number;
  now?: number;
}): Promise<VerifiedWebhook> {
  const result = await verifyPayloadInner(input);
  if (!result.valid) {
    throw new WebhookVerificationError(result.reason);
  }
  return { payload: input.payload, timestamp: result.timestamp };
}

// ──────────────────────────────────────────────────────────────────────────
// Internal — single source of truth for the verification state machine.
// ──────────────────────────────────────────────────────────────────────────

type InternalResult =
  | { valid: true; timestamp: number }
  | { valid: false; reason: VerifyFailureReason };

async function verifyPayloadInner(input: {
  payload: string;
  header: string | null | undefined;
  secret: string;
  tolerance?: number;
  now?: number;
}): Promise<InternalResult> {
  if (input.header == null || input.header === "") {
    return { valid: false, reason: "missing-header" };
  }
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { valid: false, reason: "malformed-header" };

  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp-outside-tolerance" };
  }

  const expected = await hmacSha256Hex(
    input.secret,
    `${parsed.timestamp}.${input.payload}`
  );
  for (const sig of parsed.signatures) {
    if (timingSafeEqual(sig.toLowerCase(), expected)) {
      return { valid: true, timestamp: parsed.timestamp };
    }
  }
  return { valid: false, reason: "signature-mismatch" };
}

// ──────────────────────────────────────────────────────────────────────────
// Primitives — Web Crypto + byte-level constant-time equality.
// Exported under anyhook-verify/testing for test fixture generation
// (see ./testing.ts) but kept internal here to discourage casual import.
// ──────────────────────────────────────────────────────────────────────────

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i].toString(16).padStart(2, "0");
  }
  return out.join("");
}

/**
 * Constant-time string equality. Same shape as the helper in
 * `@anyhook/core` — see that file for why we don't use Node's
 * `crypto.timingSafeEqual` here (cross-runtime: Edge runtimes have
 * Web Crypto only, not the Node `crypto` module).
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
