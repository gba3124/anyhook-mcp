import { defineConfig } from "tsup";

// Bundle for npm — two ESM entries (main + /testing), types co-located,
// no Node-specific imports so the package keeps working on Edge runtimes.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: {
    entry: {
      index: "src/index.ts",
      testing: "src/testing.ts",
    },
  },
  clean: true,
});
