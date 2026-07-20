/**
 * Test fixture helpers — generate a valid Anyhook-Signature header for
 * a given secret + body + timestamp. Use in your own integration tests
 * so you don't have to copy 20 lines of Web Crypto.
 *
 *   import { signWebhook } from "anyhook-verify/testing";
 *
 *   const header = await signWebhook({ secret, timestamp, payload });
 *   const req = new Request(url, { method: "POST", headers: { "Anyhook-Signature": header }, body: payload });
 *
 * This is kept in a separate sub-export so it doesn't pollute the
 * production bundle of every webhook handler with code that exists
 * only to forge test deliveries. Importing it in your production code
 * is a smell — that's why it's not in the main entry.
 */
import { hmacSha256Hex } from "./verify";

/**
 * Build a wire-format `Anyhook-Signature` header value from its parts.
 *
 * Returns the full header string, e.g.
 *   `t=1716567890,v1=a3f2…b7e8`
 *
 * Multiple signatures (for key rotation tests) can be produced by
 * calling this twice with different secrets and joining the v1
 * segments:
 *
 *   const a = await signWebhook({ secret: oldSecret, timestamp, payload });
 *   const b = await signWebhook({ secret: newSecret, timestamp, payload });
 *   const v1a = a.split(",v1=")[1];
 *   const v1b = b.split(",v1=")[1];
 *   const dualHeader = `t=${timestamp},v1=${v1a},v1=${v1b}`;
 */
export async function signWebhook(input: {
  secret: string;
  /** Unix seconds. Pass a fixed value in tests so assertions are deterministic. */
  timestamp: number;
  payload: string;
}): Promise<string> {
  const sig = await hmacSha256Hex(input.secret, `${input.timestamp}.${input.payload}`);
  return `t=${input.timestamp},v1=${sig}`;
}
