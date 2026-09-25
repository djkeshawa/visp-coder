import { defineConfig } from "vitest/config";
import { runtimeDefines } from "./tests/runtime-defines.js";

export default defineConfig({
  define: runtimeDefines,
  test: {
    include: ["tests/**/*.test.ts"],
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts", "src/cli/main.ts"],
      reporter: ["text", "html"],
    },
  },
});
