# anyhook-mcp

An MCP server that gives AI agents eyes on webhooks — inspect events, replay deliveries, mock signed payloads, create apps. Designed for the `45-second AI handler` workflow.

Apache 2.0 · `npm i -g anyhook-mcp`

---

## Zero-config (new in 0.2.0)

No API key needed to start:

```bash
claude mcp add anyhook -- npx -y anyhook-mcp
```

Then ask your agent to run **`anyhook_quickstart`** — it creates a free relay
endpoint + API key instantly (no signup), and this MCP session auto-connects.
All account tools (events, replay, apps) work immediately. The response includes
a `claim_url` to keep the endpoint permanently.

## What it does

Drop this MCP server into Claude Desktop / Cursor / Claude Code and your agent can:

- `anyhook_apps_list` — see every app in your AnyHook account with its inbound URL
- `anyhook_apps_create` — spin up a new app from a prompt
- `anyhook_events` — list recent events, filter by app / status
- `anyhook_inspect` — pull a single event's headers, body, signature status
- `anyhook_replay` — re-send a stored event to its destinations (does not burn quota)
- `anyhook_undelivered` — list events that never reached a destination
- `anyhook_replay_failed` — bulk-replay every failed event for an app
- `anyhook_mock` — generate a signed Stripe / GitHub / Slack payload for local handler testing
- `anyhook_verify` — verify any incoming signature against your secret
- `anyhook_providers` — list every webhook provider AnyHook supports

Two modes:

| Mode | When | What works |
|---|---|---|
| **remote** | `ANYHOOK_API_KEY` is set | All tools above — live against your AnyHook account |
| **local** | No API key | Provider toolkit (`mock` / `verify` / `providers`) + an in-memory store you can simulate events into. Useful for trying it out before signing up. |

---

## Quick start

```bash
npm install -g anyhook-mcp
# or run without installing
npx -y anyhook-mcp
```

Get an API key from <https://www.anyhook.net/dashboard/settings/api-keys>. Keys start with `ahk_live_`.

---

## Install in Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "anyhook": {
      "command": "npx",
      "args": ["-y", "anyhook-mcp"],
      "env": {
        "ANYHOOK_API_KEY": "ahk_live_xxxxxxxx"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear under the hammer icon.

---

## Install in Cursor

Open `Settings → MCP → Add new MCP server`. Or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "anyhook": {
      "command": "npx",
      "args": ["-y", "anyhook-mcp"],
      "env": {
        "ANYHOOK_API_KEY": "ahk_live_xxxxxxxx"
      }
    }
  }
}
```

---

## Install in Claude Code

```bash
claude mcp add anyhook -e ANYHOOK_API_KEY=ahk_live_xxxxxxxx -- npx -y anyhook-mcp
```

Or edit `~/.claude/mcp.json` directly with the same structure as above.

---

## Local-only mode (no account needed)

Skip the env var:

```json
{
  "mcpServers": {
    "anyhook": {
      "command": "npx",
      "args": ["-y", "anyhook-mcp"]
    }
  }
}
```

The agent gets `anyhook_mock`, `anyhook_verify`, `anyhook_providers`, `anyhook_simulate`, `anyhook_events` (against memory store), and `anyhook_inspect` (against memory store). Useful for "generate me a signed Stripe `payment_intent.succeeded` and POST it to localhost:3000" flows during local dev.

---

## Example conversations

**Triage a failing endpoint:**

> "Show me undelivered events for the `stripe-prod` app from the last hour, then replay them."

The agent calls `anyhook_undelivered` then `anyhook_replay` for each, surfacing the responses inline.

**Create an app for a new integration:**

> "Make a new AnyHook app called `replicate-video-jobs`, source `generic`, point it at `https://my-app.vercel.app/api/replicate-callback`."

Calls `anyhook_apps_create`, returns the inbound URL you paste into Replicate.

**Sanity-check a signature failure:**

> "Here's an inbound payload from Stripe that AnyHook is rejecting. Verify the signature manually with secret `whsec_xxx`."

Calls `anyhook_verify` with the supplied headers + body + secret, returns `valid: false` plus the failure reason.

**Mock a webhook for local testing:**

> "Generate a Stripe `payment_intent.succeeded` event and POST it to <http://localhost:3000/api/webhooks/stripe>."

Calls `anyhook_mock` with `targetUrl` set; returns the request that was sent + your handler's response.

---

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `ANYHOOK_API_KEY` | for remote mode | — | `ahk_live_*` from <https://www.anyhook.net/dashboard/settings/api-keys> |
| `ANYHOOK_API_BASE` | no | `https://www.anyhook.net` | Override for self-hosted AnyHook deployments |

---

## Why this is interesting

AI agents have been blind to their own webhook infrastructure. They can write the integration code, but once an event misbehaves in production they can't see it — you tell them what happened. With this MCP server, Claude / Cursor can read the actual event log, replay deliveries, debug signature failures, and even spin up new apps. It closes the loop between writing webhook code and operating it.

---

## License

Apache-2.0 © AnyHook
