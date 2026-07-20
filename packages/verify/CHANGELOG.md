# Changelog

All notable changes to `anyhook-verify` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-25

Initial release.

### Added

- `verifyWebhook(req, secret, options?)` — boolean verifier for Web Fetch `Request` objects. Reads the body via `req.clone().text()` so the caller can still consume it afterwards.
- `verifyWebhookOrThrow(req, secret, options?)` — Stripe-SDK-style variant that throws `WebhookVerificationError` on failure and returns `{ payload, timestamp }` on success.
- `verifyPayload({ payload, header, secret, ... })` — string-body variant for frameworks that have already consumed the raw body (Express raw body, queue replays, etc).
- `verifyPayloadOrThrow({ ... })` — throwing variant of `verifyPayload`.
- `parseSignatureHeader(value)` — exposed parser for `Anyhook-Signature` headers. Returns `{ timestamp, signatures }` or `null`. Never throws.
- `WebhookVerificationError extends Error` — thrown by the `*OrThrow` variants with a typed `reason` field: `"missing-header" | "malformed-header" | "timestamp-outside-tolerance" | "signature-mismatch" | "body-already-consumed"`.
- `signWebhook({ secret, timestamp, payload })` test fixture helper, available via the `anyhook-verify/testing` sub-export.

### Security

- Constant-time signature comparison via `TextEncoder` → `Uint8Array` byte XOR accumulation. Cross-runtime so Edge runtimes work without falling back to `node:crypto`.
- Default ±5 minute replay tolerance, override via `options.tolerance`.
- Defensive parsing rejects non-positive `t=` timestamps (never legitimately produced by the AnyHook forwarder).
- `req.bodyUsed` check returns `false` / throws a clear `"body-already-consumed"` reason instead of letting `Request.clone()` throw cryptically.

### Internal

- ESM-only build via tsup, ES2022 target.
- Zero runtime dependencies — pure Web Crypto.
- `engines.node >= 20`.
- `sideEffects: false` so bundlers can tree-shake unused exports.
- Two `exports` entries (`.` + `./testing`), independent dist chunks for tree-shaking.
- 31 vitest tests covering parse, round-trip, rejection paths, key rotation (multiple `v1=` segments), throw variants, error reasons, body-already-consumed, and deterministic signing.

[Unreleased]: https://github.com/gba3124/anyhook/compare/verify-v0.1.0...HEAD
[0.1.0]: https://github.com/gba3124/anyhook/releases/tag/verify-v0.1.0
