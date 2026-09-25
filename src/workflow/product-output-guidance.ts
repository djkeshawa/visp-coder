import { basename } from "node:path";
import { resolveCommand } from "../core/exec.js";
import { isBrowserCheckCommand } from "./product/check-command.js";
import type { ProductCheck } from "./product/model.js";

export const CHECK_OUTPUT_GUIDANCE =
  "Checks must leave product inputs unchanged. Declare generated-output ignore rules before authorization, while keeping source, configuration and declared check inputs tracked. Python -B suppresses import caches; explicit py_compile/compileall still write bytecode even with -B. For syntax-only checks, compile(source, filename, 'exec') does not write bytecode; otherwise use an explicit output directory outside product inputs.";

export function checkOutputNotes(checks: readonly ProductCheck[]): string[] {
  return checks.flatMap((check) => {
    if (isBrowserCheckCommand(check.command)) return [];
    const command = resolveCommand(check.command);
    if (
      !command.ok ||
      !/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(command.value[0] ?? ""))
    )
      return [];
    const module = command.value.indexOf("-m");
    return module >= 0 && ["py_compile", "compileall"].includes(command.value[module + 1] ?? "")
      ? [`${check.id}: ${CHECK_OUTPUT_GUIDANCE}`]
      : [];
  });
}
