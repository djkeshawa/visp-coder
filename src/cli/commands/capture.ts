import { Command } from "commander";
import { fromUnknown } from "../../core/errors.js";
import type { Result } from "../../core/result.js";
import { runProductCapture } from "../../workflow/evidence/product-capture.js";
import { runProductControl } from "../../workflow/evidence/product-control.js";
import {
  productResultFailed,
  productWithoutImageBytes,
  renderProductResult,
} from "../../workflow/product-presentation.js";
import type { WorkspaceState } from "../../workflow/state.js";
import { isJson, mutatingWorkspace, options } from "../context.js";
import { readCommandInput } from "../input.js";
import { emit, emitError } from "../output.js";

interface CaptureOptions {
  feature?: string;
  task?: string;
  from?: string;
  replay?: string;
  binary?: string;
}
function runtimeCommand(
  name: string,
  description: string,
  run: (state: WorkspaceState, flags: CaptureOptions, input: unknown) => Promise<Result<unknown>>,
  inputRequired = true,
): Command {
  const command = new Command(name).description(description);
  const inputHelp = "YAML or JSON execution description; - reads stdin";
  if (inputRequired) command.requiredOption("--from <path>", inputHelp);
  else command.option("--from <path>", inputHelp);
  return command
    .option("--feature <id>")
    .option("--task <id>")
    .action(async (_flags: unknown, command: Command) => {
      const flags = options<CaptureOptions>(command);
      try {
        const loaded = await mutatingWorkspace(flags);
        if (!loaded.ok) {
          process.exitCode = emitError(name, loaded.error, { json: isJson(flags) });
          return;
        }
        const result = await run(
          loaded.value,
          flags,
          flags.from === undefined ? undefined : await readCommandInput(loaded.value, flags.from),
        );
        process.exitCode = emit(
          name,
          result.ok ? { ok: true, value: productWithoutImageBytes(result.value) } : result,
          {
            json: isJson(flags),
            text: renderProductResult,
          },
        );
        if (result.ok && productResultFailed(result.value)) process.exitCode = 1;
      } catch (cause) {
        process.exitCode = emitError(name, fromUnknown(cause, "ARTIFACT_INVALID"), {
          json: isJson(flags),
        });
      }
    });
}
export const captureCommand = () =>
  runtimeCommand(
    "capture",
    "Capture a real browser journey with an isolated installed browser, including optional viewport resize",
    (state, flags, journey) => runProductCapture(state, { ...flags, journey }),
    false,
  )
    .option(
      "--replay <run-id>",
      "Rerun a recorded journey against current code and compare observations",
    )
    .option(
      "--binary <path>",
      "Installed Chrome/Chromium executable; defaults to CHROME_BIN or google-chrome",
    );
export const controlCommand = () =>
  runtimeCommand(
    "control",
    "Run one shared verifier against baseline and changed subjects",
    (state, flags, experiment) => runProductControl(state, { ...flags, experiment }),
  );
