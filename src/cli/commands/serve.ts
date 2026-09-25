import { Command } from "commander";
import { EXIT, PRODUCT_NAME } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { serveStdio } from "../../mcp/server.js";
import { isJson, options, projectRoot } from "../context.js";
import { emitError } from "../output.js";

/**
 * Serving keeps the process alive, so it never writes to stdout: the MCP
 * transport owns that stream.
 */
export function serveCommand(): Command {
  return new Command("serve")
    .description("Serve visp's capabilities to an agent over MCP")
    .option("--mcp", "Serve over MCP on stdio (currently the only transport)")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<{ mcp?: boolean }>(command);

      if (opts.mcp !== true) {
        // UNSUPPORTED maps to EXIT.usage, which is what a missing flag means.
        emitError(
          "serve",
          vispError("UNSUPPORTED", "--mcp is required; it is the only transport", {
            recovery: `${PRODUCT_NAME} serve --mcp`,
          }),
          { json: isJson(opts) },
        );
        process.exitCode = EXIT.usage;
        return;
      }

      const result = await serveStdio(projectRoot(opts));
      if (!result.ok) {
        process.exitCode = emitError("serve", result.error, { json: isJson(opts) });
      }
    });
}
