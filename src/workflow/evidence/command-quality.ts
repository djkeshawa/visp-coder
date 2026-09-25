/** Flags that inspect a runner but deliberately execute no project behavior. */
const NON_EXECUTING_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
  "--list",
  "--list-tests",
  "--collect-only",
  "--dry-run",
]);

const STATIC_INSPECTION_COMMANDS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "ls",
  "rg",
  "sed",
  "tail",
  "wc",
]);

const BROWSER_OBSERVATION_ACTIONS = new Set(["capture", "open", "pdf", "screenshot", "snapshot"]);
const BROWSER_OBSERVATION_FLAGS = ["--dump-dom", "--screenshot", "--print-to-pdf"] as const;

/**
 * A command can exit successfully while proving nothing. Keep this check
 * syntactic and conservative: these well-known modes explicitly suppress the
 * execution that a validation receipt is meant to attest to.
 */
export function nonExecutingValidationMode(argv: readonly string[]): string | undefined {
  return argv.slice(1).find((argument) => NON_EXECUTING_FLAGS.has(argument));
}

/** Node's syntax-only mode is executable for other interpreters and runners. */
export function syntaxOnlyValidationMode(argv: readonly string[]): string | undefined {
  const executable = nodeExecutableIndex(argv);
  if (executable < 0) return undefined;
  for (const argument of argv.slice(executable + 1)) {
    if (argument === "--") break;
    if (argument === "--check" || argument === "-c") return argument;
    if (!argument.startsWith("-")) break;
  }
  return undefined;
}

/** A successful source listing or text search is static evidence, never behavior. */
export function staticInspectionCommand(argv: readonly string[]): string | undefined {
  const executable = commandBasename(argv[0] ?? "").toLowerCase();
  return STATIC_INSPECTION_COMMANDS.has(executable) ? executable : undefined;
}

/**
 * Browser launch and capture commands create observations but contain no
 * interaction assertion. Keep this syntactic so an executable test runner is
 * never rejected merely because its test happens to take a screenshot.
 */
export function browserObservationMode(argv: readonly string[]): string | undefined {
  const tokens = argv.map((argument) => argument.toLowerCase());
  const browserExecutable = /^(?:google-chrome(?:-stable)?|chromium(?:-browser)?|chrome|firefox)$/;
  if (browserExecutable.test(commandBasename(tokens[0] ?? ""))) {
    const flag = tokens
      .slice(1)
      .find((token) =>
        BROWSER_OBSERVATION_FLAGS.some(
          (candidate) => token === candidate || token.startsWith(`${candidate}=`),
        ),
      );
    if (flag) return flag.split("=", 1)[0];
  }
  const runner = tokens.findIndex((token) =>
    /(?:^|[/\\])(?:playwright|playwright_cli|browser)(?:[._-]|$)/.test(token),
  );
  if (runner === -1) return undefined;
  const action = tokens.slice(runner + 1).find((token) => BROWSER_OBSERVATION_ACTIONS.has(token));
  return action;
}

function commandBasename(command: string): string {
  return command.split(/[\\/]/).at(-1) ?? command;
}

function nodeExecutableIndex(argv: readonly string[]): number {
  const first = commandBasename(argv[0] ?? "")
    .toLowerCase()
    .replace(/\.(?:exe|cmd)$/, "");
  if (isNode(argv[0] ?? "")) return 0;
  if (first === "npx") return immediateExecutableIndex(argv, 1);
  if (["pnpm", "npm", "yarn", "bun"].includes(first) && argv[1] === "exec")
    return immediateExecutableIndex(argv, 2);
  return -1;
}

function immediateExecutableIndex(argv: readonly string[], start: number): number {
  let index = start;
  while (index < argv.length) {
    const argument = argv[index] ?? "";
    if (argument === "--") {
      index++;
      break;
    }
    if (argument === "--package" || argument === "-p") index += 2;
    else if (argument.startsWith("--package=") || ["--yes", "-y", "--no"].includes(argument))
      index++;
    else break;
  }
  return index < argv.length && isNode(argv[index] ?? "") ? index : -1;
}

function isNode(argument: string): boolean {
  const executable = commandBasename(argument)
    .toLowerCase()
    .replace(/\.exe$/, "");
  return executable === "node" || executable === "nodejs";
}
