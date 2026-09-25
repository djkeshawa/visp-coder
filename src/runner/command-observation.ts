import { parseCommand } from "../core/exec.js";

const maxRawCommandLength = 65_536;
const maxCommandArguments = 256;
const maxCommandArgumentLength = 4_096;
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
const shellExecutable = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "/bin/bash",
  "/bin/sh",
  "/usr/bin/bash",
  "/usr/bin/sh",
]);

function hasNonAsciiWhitespace(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 0x7f && /\s/u.test(character);
  });
}

/**
 * Parses a host-reported command only when it has one unambiguous argv form.
 * Shell syntax is deliberately rejected even when it appears inside quotes;
 * the one supported wrapper is the native `/bin/bash -lc 'command'` form.
 */
export function parseObservedCommand(value: unknown): readonly string[] | undefined {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > maxRawCommandLength ||
    value.includes("#") ||
    /\p{Cc}/u.test(value) ||
    hasNonAsciiWhitespace(value)
  )
    return undefined;
  const parsed = parseCommand(value);
  if (!parsed.ok) return undefined;
  if (
    parsed.value.some(
      (argument) =>
        !argument.length || argument.length > maxCommandArgumentLength || /\p{Cc}/u.test(argument),
    )
  )
    return undefined;
  if (parsed.value[0] === "/bin/bash" && parsed.value[1] === "-lc") {
    if (parsed.value.length !== 3) return undefined;
    const wrappedCommand = parsed.value[2];
    if (wrappedCommand === undefined) return undefined;
    const wrapped = parseCommand(wrappedCommand);
    return wrapped.ok ? simpleArgv(wrapped.value) : undefined;
  }
  return simpleArgv(parsed.value);
}

function simpleArgv(argv: readonly string[]): readonly string[] | undefined {
  if (!argv.length || argv.length > maxCommandArguments) return undefined;
  if (
    shellExecutable.has(argv[0] ?? "") ||
    argv[0] === "cd" ||
    argv[0] === "echo" ||
    argv[0] === "env"
  )
    return undefined;
  if (
    argv.some(
      (argument) =>
        !argument.length || argument.length > maxCommandArgumentLength || assignment.test(argument),
    )
  )
    return undefined;
  if (argv.some((argument) => /\p{Cc}/u.test(argument))) return undefined;
  return [...argv];
}

export function sameCommand(
  observed: readonly string[] | undefined,
  required: readonly string[],
): boolean {
  return (
    observed !== undefined &&
    observed.length === required.length &&
    observed.every((argument, index) => argument === required[index])
  );
}
