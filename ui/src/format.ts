import type { ExecutionStatus, NextAction, UiNext } from "../../src/ui/contract.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const elapsed = now - then;
  if (elapsed < 45_000) return "just now";
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)} h ago`;
  if (elapsed < 7 * DAY) return `${Math.round(elapsed / DAY)} d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fullTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === today) return "Today";
  if (day === today - DAY) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < MINUTE) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / MINUTE);
  return `${minutes} min ${Math.round((ms % MINUTE) / 1_000)} s`;
}

export function bytes(count: number): string {
  if (count < 1_024) return `${count} B`;
  if (count < 1_048_576) return `${(count / 1_024).toFixed(1)} KB`;
  return `${(count / 1_048_576).toFixed(1)} MB`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export type Tone = "neutral" | "good" | "bad" | "warn" | "live";

/** What the agent is doing, said the way a person would say it. */
export function describeNext(next: UiNext): { headline: string; tone: Tone } {
  if (next.completion === "handoff") return { headline: "Handed over to you", tone: "warn" };
  if (next.completion === "unresolved-environment")
    return { headline: "Blocked by the environment", tone: "warn" };
  // "unresolved-product" means problems remain while the agent keeps working, so
  // the action, not the completion, says what is happening.
  const words: Record<NextAction, { headline: string; tone: Tone }> = {
    understand: { headline: "Shaping the brief", tone: "live" },
    implement: { headline: next.mayEdit ? "Building" : "Ready to build", tone: "live" },
    fix: { headline: "Fixing what failed", tone: "bad" },
    refine: { headline: "Answering review findings", tone: "warn" },
    accept: { headline: "Ready for acceptance", tone: "good" },
    complete: { headline: "Accepted", tone: "good" },
    wait: { headline: "Independent review running", tone: "live" },
  };
  return words[next.action];
}

export function executionWord(status: ExecutionStatus): string {
  return status === "passed" ? "Passed" : status === "failed" ? "Failed" : "Could not run";
}

export function executionTone(status: ExecutionStatus): Tone {
  return status === "passed" ? "good" : status === "failed" ? "bad" : "warn";
}

/**
 * A POSIX single-quoted word. Inside single quotes nothing expands — not `$`, not
 * backticks — so pasting the command runs exactly the text the person typed.
 */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function withQuotedAnswer(prefix: string, answer: string): string {
  return `${prefix} ${shellQuote(answer)}`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
export const stripAnsi = (text: string) => text.replace(ANSI, "");
const FAILURE_LINE = /\b(?:not ok|fail(?:ed|ure|ing)?|error|assert(?:ion)?(?:error)?)\b|✖|×/i;
const ZERO_FAILURES = /\bfail(?:ed|ures?)?\s*[:=]?\s*0\b|\b0\s+fail(?:ed|ures?)?\b/i;

/** A line worth highlighting in output: it reads like a failure and isn't a "0 failed" summary. */
export const isFailureLine = (line: string) => FAILURE_LINE.test(line) && !ZERO_FAILURES.test(line);
