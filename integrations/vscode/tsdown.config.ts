import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/extension.ts"],
  outDir: "out",
  format: "cjs",
  fixedExtension: false,
  deps: {
    neverBundle: ["vscode"]
  },
  dts: false
});
