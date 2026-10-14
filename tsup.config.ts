import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Options } from "tsup";
import { computeBuildId } from "./src/build/build-id.js";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };
const buildId = computeBuildId(process.cwd());

// `import text from "./x.script.mjs?raw"` inlines the file's text, as Vite does in the tests.
const rawScripts: NonNullable<Options["esbuildPlugins"]>[number] = {
  name: "raw-scripts",
  setup(build) {
    build.onResolve({ filter: /\.script\.mjs\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
      namespace: "raw-script",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw-script" }, (args) => ({
      contents: readFileSync(args.path, "utf8"),
      loader: "text",
    }));
  },
};

export default defineConfig({
  esbuildPlugins: [rawScripts],
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
