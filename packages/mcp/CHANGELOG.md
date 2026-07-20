# Changelog

All notable changes to `anyhook-mcp` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] — 2026-07-20

### Added

- Zero-config remote endpoint: the same server is hosted at `https://anyhook.net/mcp` (streamable HTTP). Connect from claude.ai connectors, ChatGPT, or any HTTP client with `{ "url": "https://anyhook.net/mcp" }` — nothing to install.
- `api_key` argument on account tools, so a keyless HTTP session can carry the key returned by `anyhook_quickstart` (the stateless transport can't hold it).

### Changed

- All outbound requests now send an explicit `User-Agent`: mocked webhooks carry realistic provider UAs (`Stripe/1.0…`, `GitHub-Hookshot`, `Slackbot 1.0…`); the API client and quickstart send `anyhook-mcp/x`. Avoids edge bot filters (e.g. Cloudflare Bot Fight Mode) that reject bare library user-agents.

## [0.1.0] — 2026-05-25

Initial release.

### Added

Two-mode MCP server selected by env at boot.

**Always-on toolkit** (works in both modes):

- `anyhook_mock` — generate a webhook request with a valid signature for Stripe, GitHub, or Slack. Optional `targetUrl` to POST it.
- `anyhook_verify` — verify a signature against a secret. Supports 19 providers via the underlying signature module.
- `anyhook_providers` — list supported providers and their event types.

**Remote-mode tools** (require `ANYHOOK_API_KEY`):

- `anyhook_apps_list` — list AnyHook apps in the user's account with inbound URLs.
- `anyhook_apps_create` — create a new app from a prompt.
- `anyhook_events` — list recent events filtered by app slug / status / limit.
- `anyhook_inspect` — look up a single event by id from the latest 200.
- `anyhook_replay` — re-send a stored event to its destinations. Replay does NOT consume monthly event quota.
- `anyhook_undelivered` — list events for an app that haven't successfully reached any destination.
- `anyhook_replay_failed` — bulk-replay every failed event for an app.

**Local-mode-only tool** (no API key set):

- `anyhook_simulate` — generate a mocked webhook AND insert it into an in-memory event store so the inspect/list flow can be exercised without a real provider.

### Distribution

- `bin: anyhook-mcp` — installable via `npx -y anyhook-mcp`, runs over stdio transport for Claude Desktop / Cursor / Claude Code.
- `mcpName: io.github.gba3124/mcp` — namespace claim for the official MCP Registry.
- `server.json` manifest (schema `2025-07-09`) ships in the npm tarball — declares `ANYHOOK_API_KEY` (secret) and `ANYHOOK_API_BASE` (overridable for self-hosted) for client-side configuration UI.

### Internal

- ESM-only build via tsup, Node 24 target.
- `@anyhook/core` bundled into the dist (`noExternal`) so the published package has no workspace dep — single `dist/cli.js` 47 KB self-contained.
- `@modelcontextprotocol/sdk@^1.29.0`.
- `console.error`-only logging per stdio transport requirement.
- Tool naming follows MCP convention: `snake_case` + namespace prefix (`anyhook_*`).
- 21 vitest tests — 12 handler tests against the memory store + 9 remote-mode smoke tests with a stubbed `AnyHookClient`.

[Unreleased]: https://github.com/gba3124/anyhook/compare/mcp-v0.1.0...HEAD
[0.1.0]: https://github.com/gba3124/anyhook/releases/tag/mcp-v0.1.0
