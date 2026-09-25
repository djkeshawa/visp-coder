import { Command } from "commander";
import { readObservations } from "../../workflow/evidence/observations-reader.js";
import {
  productWithoutImageBytes,
  renderProductResult,
} from "../../workflow/product-presentation.js";
import { isJson, options, workspaceWithFeature } from "../context.js";
import { emit, emitError } from "../output.js";

/** CLI companions expose immutable local paths; multimodal clients can request the MCP image tool. */
export function observationsCommand(): Command {
  return new Command("observations")
    .description("List a criterion's captured output, freshness, and image paths for inspection")
    .option("--outcome <id>", "Product outcome to inspect")
    .option("--criterion <id>", "Historical acceptance criterion to inspect")
    .option("--task <id>", "Limit to one task")
    .option("--feature <id>", "Feature (defaults to active)")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<{
        criterion?: string;
        outcome?: string;
        task?: string;
        feature?: string;
      }>(command);
      const scope = await workspaceWithFeature(opts);
      if (!scope.ok) {
        process.exitCode = emitError("observations", scope.error, { json: isJson(opts) });
        return;
      }
      const { state, feature } = scope.value;
      const selected = await readObservations(state, { ...opts, feature });
      if (!selected.ok) {
        process.exitCode = emitError("observations", selected.error, { json: isJson(opts) });
        return;
      }
      if (selected.value.workflow === "product") {
        process.exitCode = emit(
          "observations",
          { ok: true, value: productWithoutImageBytes(selected.value.bundle) },
          { json: isJson(opts), text: renderProductResult },
        );
        return;
      }
      const bundle = { ok: true as const, value: selected.value.bundle };
      const result = bundle.ok
        ? {
            ok: true as const,
            value: {
              observations: bundle.value.observations,
              images: bundle.value.images.map(({ data: _data, ...image }) => ({
                ...image,
                path: state.paths.absolute(image.path),
              })),
              omitted: bundle.value.omitted,
            },
          }
        : bundle;
      process.exitCode = emit("observations", result, {
        json: isJson(opts),
        text: (value) =>
          `Open these images with your image viewer before judging them. Delivery is not verification.\n${JSON.stringify(value, null, 2)}`,
      });
    });
}
