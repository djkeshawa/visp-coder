import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { computeBuildId } from "./src/build/build-id.js";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };
const buildId = computeBuildId(process.cwd());

export default defineConfig({
  entry: {
    cli: "src/cli/main.ts",
    migrate: "src/migration/main.ts",
    index: "src/index.ts",
    graph: "src/graph/index.ts",
    runner: "src/runner/main.ts",
    "runner-api": "src/runner/index.ts",
    testing: "src/testing/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: true,
  // One source of truth for the version, so `--version` cannot drift from what
  // is published and the generated CI workflow pins to something that exists.
  define: {
    __VISP_VERSION__: JSON.stringify(version),
    __VISP_BUILD_ID__: JSON.stringify(buildId),
  },
  banner: { js: "#!/usr/bin/env node" },
});
