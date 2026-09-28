import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { runtimeDefines } from "./tests/runtime-defines.js";

export default defineConfig({
  define: runtimeDefines,
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/host-isolation.ts"],
    // Test files isolate their own temp workspaces, so they scale with cores. On a
    // 16-core machine 6 workers ran the suite about twice as fast as 2; the cap
    // keeps a many-core host from oversubscribing the git and CLI subprocesses
    // the tests spawn. `--maxWorkers=N` still overrides.
    maxWorkers: Math.max(2, Math.min(6, Math.floor(availableParallelism() / 2))),
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
