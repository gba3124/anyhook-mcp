// Shebang is added by tsup at build time so the installed binary is
// executable via `npx -y anyhook-mcp` from a vanilla npm install.
// In dev (`tsx src/cli.ts`) the file runs directly through tsx.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAnyHookMcpServer } from "./server";
import { loadConfig } from "./config";
import { runListen } from "./listen";

async function main() {
  if (process.argv[2] === "listen") process.exit(await runListen(process.argv.slice(3)));

  const config = loadConfig();
  const server = createAnyHookMcpServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't pollute the MCP protocol on stdout
  const banner =
    config.mode === "remote"
      ? `[anyhook-mcp] connected (remote mode, api=${config.apiBase})`
      : `[anyhook-mcp] connected (local mode, set ANYHOOK_API_KEY to query your account)`;
  console.error(banner);
}

main().catch((err) => {
  console.error("[anyhook-mcp] fatal:", err);
  process.exit(1);
});
