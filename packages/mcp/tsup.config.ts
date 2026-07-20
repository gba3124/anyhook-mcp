import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  dts: { entry: "src/index.ts", resolve: true },
  clean: true,
  // Bundle @anyhook/core into the MCP dist so users only need to install
  // anyhook-mcp from npm — no second workspace publish dance required.
  // The MCP-shaped exports of core (signature, mock, store) are inlined.
  noExternal: ["@anyhook/core"],
  // Preserve the #!/usr/bin/env node shebang in dist/cli.js so it stays runnable.
  banner: { js: "#!/usr/bin/env node" },
});
