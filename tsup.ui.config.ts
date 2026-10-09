import { defineConfig } from "tsup";

// The browser half of `visp ui`, built after the CLI into dist/ui/ so the
// published package carries the page next to the server that serves it.
export default defineConfig({
  entry: { app: "ui/src/main.ts", "boot-theme": "ui/src/boot-theme.ts" },
  outDir: "dist/ui",
  format: ["iife"],
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: false,
  clean: false,
  dts: false,
  publicDir: "ui/public",
  outExtension: () => ({ js: ".js" }),
});
