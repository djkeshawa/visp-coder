/**
 * A next step as data: a command and its arguments, in the order a person would type them.
 * Each adapter renders it: the CLI as `visp <command> --flag value` text (renderCli), the MCP
 * server as a tool call (mcpActionFor). Producers build one with `nextAction` and never format
 * a command line by hand.
 */
export type ActionArg =
  /** A bare operand such as the goal of `visp feature` or the `feedback` of `visp critic feedback`. */
  | { readonly word: string; readonly quoted?: boolean }
  /** `--flag`, `--flag value`, `--flag "value"` or `--flag=value`. */
  | {
      readonly flag: string;
      readonly value?: string;
      readonly quoted?: boolean;
      readonly joined?: boolean;
    };

export interface NextAction {
  readonly command: string;
  readonly args: readonly ActionArg[];
}

/** A flag's value: `true` for a bare flag, `undefined` to leave the flag out. */
export type FlagValue =
  | string
  | number
  | true
  | undefined
  | { readonly quoted: string }
  | { readonly joined: string };
export type FlagSpec = Readonly<Record<string, FlagValue>>;

/**
 * Flags appear in the order of `flags`; undefined and empty ones are skipped, so the usual
 * `{ feature, task }` pair needs no conditional.
 */
export function nextAction(
  command: string,
  flags: FlagSpec = {},
  words: readonly (string | { readonly quoted: string })[] = [],
): NextAction {
  const args: ActionArg[] = words.map((word) =>
    typeof word === "string" ? { word } : { word: word.quoted, quoted: true },
  );
  for (const [flag, value] of Object.entries(flags)) {
    if (value === undefined || value === "") continue;
    if (value === true) args.push({ flag });
    else if (typeof value === "string" || typeof value === "number")
      args.push({ flag, value: String(value) });
    else if ("quoted" in value) args.push({ flag, value: value.quoted, quoted: true });
    else args.push({ flag, value: value.joined, joined: true });
  }
  return { command, args };
}

/** The command line a person would type, as the CLI prints it. */
export function renderCli(action: NextAction): string {
  const parts = ["visp", action.command];
  for (const arg of action.args) {
    if ("word" in arg) parts.push(arg.quoted ? `"${arg.word}"` : arg.word);
    else if (arg.value === undefined) parts.push(`--${arg.flag}`);
    else if (arg.joined) parts.push(`--${arg.flag}=${arg.value}`);
    else parts.push(`--${arg.flag}`, arg.quoted ? `"${arg.value}"` : arg.value);
  }
  return parts.join(" ");
}

/** Shorthand for the common case of a command line with no structure kept. */
export function cliCommand(
  command: string,
  flags: FlagSpec = {},
  words: readonly (string | { readonly quoted: string })[] = [],
): string {
  return renderCli(nextAction(command, flags, words));
}
