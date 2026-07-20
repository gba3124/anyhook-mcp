/**
 * anyhook-verify — verify Anyhook-Signature webhook deliveries.
 *
 * Quick start:
 *
 *   import { verifyWebhook } from "anyhook-verify";
 *
 *   export async function POST(req: Request) {
 *     const ok = await verifyWebhook(req, process.env.ANYHOOK_SIGNING_SECRET!);
 *     if (!ok) return new Response("invalid signature", { status: 401 });
 *     const event = await req.json();
 *     // ... your handler logic
 *   }
 *
 * Stripe-style loud-failure variant:
 *
 *   import { verifyWebhookOrThrow, WebhookVerificationError } from "anyhook-verify";
 *
 *   try {
 *     const { payload, timestamp } = await verifyWebhookOrThrow(req, SECRET);
 *     // ... handle with the verified payload (already a string)
 *   } catch (err) {
 *     if (err instanceof WebhookVerificationError) {
 *       return new Response(err.message, { status: 401 });
 *     }
 *     throw err;
 *   }
 *
 * Test fixture helpers (test-only sub-export):
 *
 *   import { signWebhook } from "anyhook-verify/testing";
 *
 * Runs in Node 20+, Bun, Deno, Cloudflare Workers, and Vercel Edge —
 * no runtime ifdefs needed.
 */
export {
  verifyWebhook,
  verifyWebhookOrThrow,
  verifyPayload,
  verifyPayloadOrThrow,
  parseSignatureHeader,
  WebhookVerificationError,
  type VerifyOptions,
  type ParsedSignatureHeader,
  type VerifiedWebhook,
  type VerifyFailureReason,
} from "./verify";
