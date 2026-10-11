# AnyHook client packages

Source for the npm packages that go with [AnyHook](https://anyhook.net), a webhook relay: change one URL and your webhooks get automatic retries, a full event log, and one-click replay.

| Package | npm | What it is |
|---------|-----|------------|
| [`anyhook-mcp`](packages/mcp) | [![npm](https://img.shields.io/npm/v/anyhook-mcp)](https://www.npmjs.com/package/anyhook-mcp) | MCP server — lets a coding agent set up and operate webhook infrastructure by itself |
| [`anyhook-verify`](packages/verify) | [![npm](https://img.shields.io/npm/v/anyhook-verify)](https://www.npmjs.com/package/anyhook-verify) | Verify `AnyHook-Signature` headers on your server (HMAC-SHA256, retry-safe) |
| `@anyhook/core` | not published | Shared internals (signature logic, provider fixtures), bundled into the two above |

## Connect an agent

Already have an AnyHook account? Add `https://anyhook.net/mcp` to Claude Code,
claude.ai, Codex or VS Code and sign in through the browser, no key to copy.
Steps for each app, Cursor included: <https://anyhook.net/mcp>.

No account yet? Run the package locally:

```json
{ "mcpServers": { "anyhook": { "command": "npx", "args": ["-y", "anyhook-mcp"] } } }
```

Its `anyhook_quickstart` tool makes a live webhook endpoint and key without an
account (7-day TTL, claimable into a free account later). That endpoint is new,
not an account you already have. From there the agent creates apps, reads and
inspects events, replays failures, and mocks or verifies signed payloads.

Prefer plain HTTP? The same bootstrap is one curl:

```bash
curl -X POST https://anyhook.net/api/v1/quickstart
```

## Development

pnpm workspace. Node 20+.

```bash
pnpm install
pnpm test    # vitest across all packages
pnpm build   # tsup
```

The hosted relay itself (ingress, forwarder, dashboard) is a separate closed-source service — this repo is the client tooling. API reference: [openapi.json](https://anyhook.net/openapi.json) · agent docs: [llms.txt](https://anyhook.net/llms.txt) · pricing: [pricing.md](https://anyhook.net/pricing.md) · MCP setup: [anyhook.net/mcp](https://anyhook.net/mcp)

## License

Apache-2.0
