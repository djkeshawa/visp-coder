import { Command } from "commander";
import { HARNESSES, PRODUCT_NAME } from "../../core/constants.js";
import { parseHarness } from "../../core/input.js";
import { runInit } from "../../workflow/stages/init.js";
import { isJson, options, projectRoot } from "../context.js";
import { emit, emitError } from "../output.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Set up visp in this project")
    .option("--harness <name>", `AI coder to configure for (${HARNESSES.join(", ")})`)
    .option("--force", "Rewrite existing configuration")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<{ harness?: string; force?: boolean }>(command);
      const harness = opts.harness ? parseHarness(opts.harness) : undefined;
      if (harness && !harness.ok) {
        process.exitCode = emitError("init", harness.error, { json: isJson(opts) });
        return;
      }

      const result = await runInit({
        root: projectRoot(opts),
        ...(harness?.ok ? { harness: harness.value } : {}),
        ...(opts.force ? { force: true } : {}),
      });

      process.exitCode = emit("init", result, {
        json: isJson(opts),
        text: (outcome) =>
          [
            `Set up visp for a ${outcome.preset} project.`,
            outcome.createdConfig ? `Wrote ${outcome.configPath}` : "Kept your existing visp.yml",
            // Choosing go or rust used to buy the workflow half silently: the
            // index parsed nothing and packs, queries and covering-tests all
            // fell back without anything saying so.
            outcome.preset === "go" || outcome.preset === "rust"
              ? `The repository index parses TypeScript, JavaScript and Python only — on this project, context packs and \`${PRODUCT_NAME} query\` fall back to path-based answers. Scope enforcement and evidence are unaffected.`
              : "",
            "Install the harness with local hooks, then review and commit the project baseline before starting a feature. VISP does not stage files or create commits.",
            "Use visp install --dry-run to inspect exact installation paths and setup requirements before writing. An assets-only (--no-hooks) installation cannot authorize coding.",
          ]
            .filter(Boolean)
            .join("\n"),
        nextCommand: () => `${PRODUCT_NAME} install`,
      });
    });
}
