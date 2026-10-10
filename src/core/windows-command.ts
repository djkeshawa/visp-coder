import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface PreparedCommand {
  readonly file: string;
  readonly args: string[];
  readonly windowsVerbatimArguments?: boolean;
}

/** Resolve a Windows npm shim and invoke it through cmd without interpolating argv. */
export function prepareCommand(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PreparedCommand {
  if (platform !== "win32") return { file, args: [...args] };
  const resolved = resolveWindowsFile(file, env);
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { file: resolved, args: [...args] };
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const commandLine = [
    escapeWindowsCommand(resolved),
    ...args.map((arg) => escapeWindowsArgument(arg, doubleEscape)),
  ].join(" ");
  return {
    file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Like Windows itself, only names with an executable extension run: Node's install directory
 * holds an extensionless `npm` shell script beside `npm.cmd`, which Windows cannot start.
 */
function resolveWindowsFile(file: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(file) || /[\\/]/.test(file)) return file;
  const path = env.Path ?? env.PATH ?? "";
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const named = extensions.some((extension) =>
    file.toLowerCase().endsWith(extension.toLowerCase()),
  );
  for (const directory of path.split(";")) {
    if (!directory) continue;
    for (const extension of named ? [""] : extensions) {
      const candidate = join(directory, `${file}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return file;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCommand(value: string): string {
  return value.replace(CMD_META, "^$1");
}

function escapeWindowsArgument(value: string, doubleEscape: boolean): string {
  let escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META, "^$1");
  return doubleEscape ? escaped.replace(CMD_META, "^$1") : escaped;
}
