import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { resolveCommandExecutable } from "../core/command-executable.js";
import type { Preset } from "../core/constants.js";
import { parseCommand, run } from "../core/exec.js";
import { suggestedValidationCommands } from "./template.js";

export interface SkippedValidationCommand {
  readonly command: string;
  readonly reason: string;
}

export interface AvailableValidationCommands {
  readonly commands: readonly string[];
  readonly skipped: readonly SkippedValidationCommand[];
}

/** Resolve tools only; never run a test script, install packages or invoke a package downloader. */
export async function availableValidationCommands(
  root: string,
  preset: Preset,
  scripts: Readonly<Record<string, string>> = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AvailableValidationCommands> {
  const commands: string[] = [];
  const skipped: SkippedValidationCommand[] = [];
  const deadline = Date.now() + 3_000;
  for (const command of suggestedValidationCommands(preset, scripts)) {
    const suggestion = await resolveSuggestion(root, command, scripts, environment, deadline);
    if (suggestion.command && !suggestion.reason) commands.push(suggestion.command);
    else
      skipped.push({
        command: suggestion.command ?? command,
        reason: suggestion.reason ?? "toolchain could not be resolved",
      });
  }
  return { commands, skipped };
}

async function resolveSuggestion(
  root: string,
  command: string,
  scripts: Readonly<Record<string, string>>,
  environment: NodeJS.ProcessEnv,
  deadline: number,
): Promise<{ command?: string; reason?: string }> {
  if (Date.now() >= deadline) return { reason: "toolchain probe time limit reached" };
  if (command === "pytest") return pythonSuggestion(root, environment, deadline);
  if (command.startsWith("npm run ")) {
    const reason = await npmUnavailableReason(
      root,
      command.slice(8),
      scripts,
      environment,
      deadline,
    );
    return reason ? { reason } : { command };
  }
  const binary = command.split(" ")[0] ?? "";
  return (await executableExists(binary, root, environment, deadline))
    ? { command }
    : { reason: `executable ${binary} was not found` };
}

async function npmUnavailableReason(
  root: string,
  script: string,
  scripts: Readonly<Record<string, string>>,
  environment: NodeJS.ProcessEnv,
  deadline: number,
): Promise<string | undefined> {
  if (!(await executableExists("npm", root, environment, deadline)))
    return "executable npm was not found";
  const scriptEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    PATH: `${join(root, "node_modules", ".bin")}${delimiter}${environment.Path ?? environment.PATH ?? ""}`,
  };
  // Windows uses Path before PATH; use the same lookup path for both spellings.
  if (process.platform === "win32") scriptEnvironment.Path = scriptEnvironment.PATH;
  for (const name of [`pre${script}`, script, `post${script}`]) {
    if (!(name in scripts)) continue;
    const binary = firstScriptExecutable(scripts[name] ?? "");
    if (!binary) return `${name}: first executable could not be determined`;
    if (!(await executableExists(binary, root, scriptEnvironment, deadline))) {
      return `${name}: executable ${binary} was not found`;
    }
  }
  return undefined;
}

/** Npm scripts use shell syntax. Inspect their leading word without executing the shell. */
function firstScriptExecutable(script: string): string | undefined {
  let remaining = script.trimStart().slice(0, 65_536);
  for (let index = 0; index < 128; index++) {
    const token = /^(?:[^\s"';&|<>`$\\]+|"[^"$`]*"|'[^']*')+/.exec(remaining)?.[0];
    if (!token) return undefined;
    remaining = remaining.slice(token.length);
    if (/^[^\s;&|<>]/.test(remaining)) return undefined;
    remaining = remaining.trimStart();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const parsed = parseCommand(token);
    return parsed.ok && parsed.value.length === 1 ? parsed.value[0] : undefined;
  }
  return undefined;
}

async function pythonSuggestion(
  root: string,
  environment: NodeJS.ProcessEnv,
  deadline: number,
): Promise<{ command?: string; reason?: string }> {
  const local = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  for (const binary of [`./.venv/${local}`, `./venv/${local}`, "python3", "python"]) {
    if (!(await executableExists(binary, root, environment, deadline))) continue;
    const probe = await run(binary, ["-c", "import pytest"], {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      replaceEnv: true,
      timeoutMs: Math.max(1, Math.min(1_000, deadline - Date.now())),
    });
    if (probe.ok && probe.value.exitCode === 0 && !probe.value.timedOut) {
      return { command: `${binary} -m pytest` };
    }
    return {
      command: `${binary} -m pytest`,
      reason: `${binary} could not import pytest${probe.ok && probe.value.timedOut ? " (probe timed out)" : ""}`,
    };
  }
  return { reason: "project Python interpreter was not found" };
}

async function executableExists(
  binary: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  deadline: number,
): Promise<boolean> {
  if (Date.now() >= deadline) return false;
  const path = (environment.Path ?? environment.PATH ?? "")
    .split(delimiter)
    .slice(0, 128)
    .join(delimiter);
  if (process.platform !== "win32")
    return Boolean(await resolveCommandExecutable(binary, root, { PATH: path }));
  const directories =
    isAbsolute(binary) || /[\\/]/.test(binary)
      ? [resolve(root, binary)]
      : path.split(delimiter).map((directory) => resolve(root, directory, binary));
  const extensions = ["", ...(environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")];
  for (const candidate of directories) {
    for (const extension of extensions) {
      if (Date.now() >= deadline) return false;
      if (await isExecutableFile(`${candidate}${extension}`)) return true;
    }
  }
  return false;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
