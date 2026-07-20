/**
 * MCP server configuration — reads env vars at startup.
 *
 * Behaviour:
 *   - If ANYHOOK_API_KEY is set → remote mode: tools query the live API
 *     against the user's real AnyHook account.
 *   - If unset → local mode: tools operate on an in-memory event store,
 *     useful for trying the server out without an account.
 *
 * The user supplies the API key via their MCP client config (e.g.
 * Claude Desktop's claude_desktop_config.json). See the README for
 * the exact JSON shape for each client.
 */

export type McpConfig = {
  apiKey?: string;
  apiBase: string;
  mode: "remote" | "local";
};

const DEFAULT_API_BASE = "https://anyhook.net";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiKey = env.ANYHOOK_API_KEY?.trim() || undefined;
  const apiBase = (env.ANYHOOK_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/$/, "");
  return {
    apiKey,
    apiBase,
    mode: apiKey ? "remote" : "local",
  };
}
