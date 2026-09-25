import { EXIT } from "../core/constants.js";
import { exitCodeFor, type VispError } from "../core/errors.js";
import type { Result } from "../core/result.js";

/**
 * One output shape for every command. `--json` prints exactly this envelope and
 * nothing else, so a caller never has to scrape prose.
 */
export interface Envelope<T> {
  readonly command: string;
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: VispError;
  /** The command to run next, when the workflow knows one. */
  readonly nextCommand?: string;
}

export interface RenderOptions {
  readonly json: boolean;
}

export function emit<T>(
  command: string,
  result: Result<T>,
  options: RenderOptions & {
    text?: (value: T) => string;
    nextCommand?: (value: T) => string | undefined;
  },
): number {
  if (!result.ok) {
    return emitError(command, result.error, options);
  }

  const nextCommand = options.nextCommand?.(result.value);
  if (options.json) {
    printJson({
      command,
      ok: true,
      data: result.value,
      ...(nextCommand ? { nextCommand } : {}),
    });
    return EXIT.ok;
  }

  const text = options.text?.(result.value);
  if (text) process.stdout.write(`${text}\n`);
  if (nextCommand) process.stdout.write(`\nNext: ${nextCommand}\n`);
  return EXIT.ok;
}

export function emitError(command: string, error: VispError, options: RenderOptions): number {
  if (options.json) {
    printJson({ command, ok: false, error });
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
    if (error.recovery) process.stderr.write(`Try: ${error.recovery}\n`);
  }
  return exitCodeFor(error);
}

/**
 * A refusal is a normal outcome, not a crash: the command succeeded at deciding
 * "no". It still exits non-zero so scripts and hooks stop.
 */
export function emitRefusal(
  command: string,
  payload: unknown,
  text: string,
  options: RenderOptions,
): number {
  if (options.json) {
    printJson({ command, ok: false, data: payload });
  } else {
    process.stdout.write(`${text}\n`);
  }
  return EXIT.refused;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Renders a delimited block for an agent to parse out of mixed output. */
export function block(name: string, body: string): string {
  return `BEGIN_${name}\n${body}\nEND_${name}`;
}

export function bullet(lines: readonly string[]): string {
  return lines.map((line) => `  - ${line}`).join("\n");
}
