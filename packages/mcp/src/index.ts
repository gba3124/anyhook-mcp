/**
 * Public library surface — re-exports for embedding the MCP server
 * inside another runtime (instead of running it via the CLI / stdio).
 *
 * Not used by Claude Desktop / Cursor / Claude Code — those go through
 * the bin entry point (`anyhook-mcp`) which spawns the stdio transport.
 */
export { createAnyHookMcpServer } from "./server";
export type { ServerOptions } from "./server";
export { loadConfig } from "./config";
export type { McpConfig } from "./config";
export { AnyHookClient, AnyHookApiError } from "./client";
export type { RemoteEvent, RemoteApp } from "./client";
