# anyhook-verify

Verify `Anyhook-Signature` webhook deliveries. Zero runtime deps. Same import in Node, Bun, Deno, Cloudflare Workers, and Vercel Edge — everything goes through Web Crypto.

Apache 2.0 · `npm i anyhook-verify`

---

## Quick start

```ts
import { verifyWebhook } from "anyhook-verify";

export async function POST(req: Request) {
  const ok = await verifyWebhook(req, process.env.ANYHOOK_SIGNING_SECRET!);
  if (!ok) return new Response("invalid signature", { status: 401 });

  const event = await req.json();
  // ... your handler logic runs here, can take 45+ seconds
  return new Response("ok", { status: 200 });
}
```

That's it. The signing secret is the per-destination value AnyHook gives you in the dashboard — copy it into your app's environment as `ANYHOOK_SIGNING_SECRET` (or any name you like).

---

## What it checks

Every call to `verifyWebhook` rejects unless **all** of these pass:

1. The request has an `Anyhook-Signature` header (case-insensitive match)
2. The header parses cleanly: `t=<unix_seconds>,v1=<hex>[,v1=<hex>...]`
3. The timestamp is within the tolerance window (default ±5 minutes) — protects against indefinite replay
4. At least one `v1` matches `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`

The body is read via `req.clone().text()` — your handler can still call `req.json()` afterwards. But if you've already consumed the body before calling `verifyWebhook`, `req.clone()` would throw — `verifyWebhook` detects this and returns `false` (the throwing variant returns `reason: "body-already-consumed"`). In that case use `verifyPayload` with the raw body string instead.

---

## Loud-failure variant (Stripe-style)

If you prefer to throw on bad signatures instead of remembering to check the boolean:

```ts
import { verifyWebhookOrThrow, WebhookVerificationError } from "anyhook-verify";

export async function POST(req: Request) {
  try {
    const { payload, timestamp } = await verifyWebhookOrThrow(
      req,
      process.env.ANYHOOK_SIGNING_SECRET!
    );
    const event = JSON.parse(payload); // already verified
    // ...
    return new Response("ok");
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      // err.reason is one of:
      //   "missing-header" | "malformed-header" |
      //   "timestamp-outside-tolerance" | "signature-mismatch" |
      //   "body-already-consumed"
      return new Response(err.message, { status: 401 });
    }
    throw err;
  }
}
```

`WebhookVerificationError.reason` is a fixed string union — branch on it for logging or metrics without parsing the message text.

---

## Framework examples

### Next.js App Router

```ts
// app/api/webhooks/anyhook/route.ts
import { verifyWebhook } from "anyhook-verify";

export async function POST(req: Request) {
  if (!(await verifyWebhook(req, process.env.ANYHOOK_SIGNING_SECRET!))) {
    return new Response("invalid", { status: 401 });
  }
  const event = await req.json();
  await handle(event);
  return new Response("ok");
}
```

### Hono / Bun / Cloudflare Workers

```ts
import { Hono } from "hono";
import { verifyWebhook } from "anyhook-verify";

const app = new Hono<{ Bindings: { ANYHOOK_SIGNING_SECRET: string } }>();

app.post("/webhooks/anyhook", async (c) => {
  if (!(await verifyWebhook(c.req.raw, c.env.ANYHOOK_SIGNING_SECRET))) {
    return c.text("invalid", 401);
  }
  const event = await c.req.json();
  await handle(event);
  return c.text("ok");
});

export default app;
```

### Express (raw body — most common gotcha)

Express's default JSON middleware **consumes the body** before your handler sees it, which breaks signature verification because the re-serialised JSON has different whitespace from what was signed. Two options — pick one:

**A. Use `express.raw()` on the webhook route only**, and pass the raw string to `verifyPayload`:

```ts
import express from "express";
import { verifyPayload, WebhookVerificationError } from "anyhook-verify";

const app = express();
// Important: NO express.json() before this route. The raw bytes must
// reach verifyPayload exactly as AnyHook signed them.
app.post(
  "/webhooks/anyhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const ok = await verifyPayload({
      payload: req.body.toString("utf8"),
      header: req.get("Anyhook-Signature") ?? null,
      secret: process.env.ANYHOOK_SIGNING_SECRET!,
    });
    if (!ok) return res.status(401).send("invalid");
    const event = JSON.parse(req.body.toString("utf8"));
    await handle(event);
    res.send("ok");
  }
);
```

**B. Mount JSON middleware with a `verify` callback** to keep the raw bytes around. This is more involved — usually option A is simpler.

---

## API

### `verifyWebhook(req, secret, options?): Promise<boolean>`

| Argument | Type | |
|---|---|---|
| `req` | `Request` | Anything that implements the Web Fetch `Request` interface |
| `secret` | `string` | Per-destination signing secret from the AnyHook dashboard |
| `options.tolerance` | `number` | Replay window in seconds. Default `300` (5 min) |
| `options.now` | `number` | Override wall clock (UNIX seconds). For tests |

Returns `true` only if every check passes. Never throws on malformed input — returns `false`.

### `verifyWebhookOrThrow(req, secret, options?): Promise<VerifiedWebhook>`

Same checks as `verifyWebhook`, but throws `WebhookVerificationError` on any failure and returns `{ payload: string; timestamp: number }` on success. Use this if you'd rather rely on the throw than remember to check the boolean.

### `verifyPayload({ payload, header, secret, tolerance?, now? }): Promise<boolean>`

String-body version of `verifyWebhook`. Use when your framework has already consumed the body (Express raw body, queue-replayed events, etc.).

### `verifyPayloadOrThrow({ ... }): Promise<VerifiedWebhook>`

Throwing variant of `verifyPayload`.

### `parseSignatureHeader(value): { timestamp, signatures } | null`

Exposed for advanced use cases — logging, multi-tenant routing, custom verification flows. Returns `null` for any malformed input — never throws.

### `class WebhookVerificationError extends Error`

Thrown by the `*OrThrow` variants. Carries a typed `reason` field — see [Loud-failure variant](#loud-failure-variant-stripe-style) above for the full enum.

---

## Test fixtures — `anyhook-verify/testing`

For your own integration tests, import the signing helper from the dedicated sub-export:

```ts
import { signWebhook } from "anyhook-verify/testing";
import { verifyWebhook } from "anyhook-verify";

it("processes a stripe.payment_intent.succeeded event", async () => {
  const body = JSON.stringify({ type: "payment_intent.succeeded", id: "pi_test" });
  const header = await signWebhook({
    secret: process.env.ANYHOOK_SIGNING_SECRET!,
    timestamp: Math.floor(Date.now() / 1000),
    payload: body,
  });
  const req = new Request("http://localhost/webhook", {
    method: "POST",
    headers: { "Anyhook-Signature": header },
    body,
  });
  // ... call your real handler with `req`
});
```

`signWebhook` is intentionally not in the main export — using it in production code is a smell (it forges deliveries with whatever secret you give it).

---

## Why a package vs inlining

Verifying a webhook signature is ~20 lines of code. You could write it yourself. The reasons to use this package anyway:

- **Cross-runtime**: same import works in Edge runtimes (no `node:crypto`)
- **Constant-time comparison**: the loop is written to give the JIT less opportunity to short-circuit
- **Replay window enforced by default**: easy to forget when hand-rolling
- **Key rotation**: multiple `v1=` segments are checked, supporting overlap during a rotation
- **No dependencies**: nothing to audit, nothing to update — Web Crypto only

If you'd rather inline, the algorithm is described in [`src/verify.ts`](./src/verify.ts) — the wire format is Stripe-compatible (`t=<unix_seconds>,v1=<hex>`).

---

## Wire format

```
Anyhook-Signature: t=1716567890,v1=a3f2…b7e8
```

- `t` — UNIX seconds when the forwarder signed the delivery. Re-signed fresh on every retry, so replays-of-old-attempts always fail the tolerance window.
- `v1=` — hex HMAC-SHA256 of `"${timestamp}.${rawBody}"` using the destination's signing secret. Multiple `v1=` entries (during key rotation) are tried in order; any match passes.

---

## Security notes

- **The raw body matters.** If your framework re-serialises JSON before you pass it to `verifyPayload`, key order / whitespace differences will break the signature. Always use the raw string the network gave you. `verifyWebhook` handles this automatically by reading from the `Request` directly — but only if you haven't already consumed the body.
- **Don't log the secret.** It's the only shared knowledge between AnyHook and your handler; treat it like a Stripe webhook signing secret. Rotate via the dashboard if you suspect leakage.
- **Tolerance should stay tight.** The default 5 minutes covers reasonable clock skew. Going to hours largely defeats the point — at that range, a leaked Anyhook-Signature header (e.g. in a captured network log) replays indefinitely.

---

## License

Apache-2.0 © AnyHook
