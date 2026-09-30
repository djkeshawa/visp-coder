import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { resolveCommand } from "../../core/exec.js";
import { productExecutionEnvironment } from "../../core/execution-environment.js";
import { isBrowserCheckCommand } from "./check-command.js";
import type { ProductCheck } from "./model.js";

/**
 * Interpreters that hosts install under another name. The gate only ever names the alias
 * and the brief patch that would use it; it never rewrites a check or runs anything.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  python: ["python3"],
  pip: ["pip3"],
};

/** Whether a bare name resolves to an executable on PATH, as a spawn would find it. */
export function resolvesOnPath(
  name: string,
  path: string = productExecutionEnvironment().PATH ?? "",
): boolean {
  return path.split(delimiter).some((directory) => {
    if (!directory) return false;
    try {
      // A directory named python passes X_OK; a spawn would not run it.
      const path = join(directory, name);
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

/** The installed alias of a bare, uninstalled interpreter name; otherwise undefined. */
export function missingAlias(
  argv0: string,
  path: string = productExecutionEnvironment().PATH ?? "",
): string | undefined {
  if (process.platform === "win32" || isAbsolute(argv0) || argv0.includes("/")) return undefined;
  const aliases = ALIASES[argv0];
  if (!aliases || resolvesOnPath(argv0, path)) return undefined;
  return aliases.find((alias) => resolvesOnPath(alias, path));
}

/** The command of a check with its executable named by `alias`, in the form the brief used. */
function aliasedCommand(check: ProductCheck, argv0: string, alias: string) {
  const command = check.command;
  if (typeof command === "string") {
    const start = command.length - command.trimStart().length;
    const rest = command.slice(start + argv0.length);
    if (command.startsWith(argv0, start) && (rest === "" || /^\s/.test(rest)))
      return `${command.slice(0, start)}${alias}${rest}`;
  }
  if (isBrowserCheckCommand(command)) return command;
  const argv = resolveCommand(command);
  return argv.ok ? [alias, ...argv.value.slice(1)] : command;
}

/** The brief patch that switches one check to the installed alias. */
export function checkFix(check: ProductCheck, argv0: string, alias: string): string {
  const patch = { checks: [{ id: check.id, command: aliasedCommand(check, argv0, alias) }] };
  return `visp brief --patch - --reason ${JSON.stringify(`${argv0} is not installed`)} with ${JSON.stringify(patch)}`;
}

/** The first executable a command check names, when it is a bare interpreter alias that is missing. */
export function uninstalledAlias(
  check: ProductCheck,
): { argv0: string; alias: string; fix: string } | undefined {
  if (check.id.startsWith("PINNED_") || isBrowserCheckCommand(check.command)) return undefined;
  const argv = resolveCommand(check.command);
  const argv0 = argv.ok ? argv.value[0] : undefined;
  const alias = argv0 === undefined ? undefined : missingAlias(argv0);
  return argv0 !== undefined && alias !== undefined
    ? { argv0, alias, fix: checkFix(check, argv0, alias) }
    : undefined;
}
