import { defineConfig } from "vitest/config";
import { runtimeDefines } from "./tests/runtime-defines.js";

export default defineConfig({
  define: runtimeDefines,
  test: {
    include: ["tests/browser/**/*.browser.ts"],
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
