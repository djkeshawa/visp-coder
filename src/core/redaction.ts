import { homedir, tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { ProjectFileSystem } from "./fs.js";
import { matchesPattern } from "./patterns.js";

export const SECRET_FILES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".npmrc",
  ".pypirc",
  ".netrc",
];
const SECRET_NAME = /secret|token|password|passwd|credential|api[_-]?key|private[_-]?key/i;
const MASK = "[REDACTED]";

export function privatePath(path: string, patterns: readonly string[] = SECRET_FILES): boolean {
  const parts = path.split("/");
  return parts.some((part, index) =>
    patterns.some(
      (pattern) =>
        matchesPattern(parts.slice(0, index + 1).join("/"), pattern) ||
        (!pattern.includes("/") && matchesPattern(part, pattern)),
    ),
  );
}

/** Applied to human text only: structural digests and evidence identities must stay intact. */
export function redactText(
  text: string,
  options: { root?: string; environment?: NodeJS.ProcessEnv; values?: readonly string[] } = {},
): string {
  let safe = text;
  for (const [path, label] of [
    [options.root, "<project>"],
    [homedir(), "~"],
    [tmpdir(), "<tmp>"],
  ] as const) {
    if (path && path.length > 1) safe = safe.replaceAll(path, label);
  }
  const values = [
    ...Object.entries(options.environment ?? process.env)
      .filter(([name, value]) => sensitiveValue(name, value))
      .map(([, value]) => value as string),
    ...(options.values ?? []),
  ].filter(Boolean);
  for (const value of [...new Set(values)].sort((a, b) => b.length - a.length))
    safe = safe.replaceAll(value, MASK);
  return safe
    .replace(
      /(\b(?:[a-z_]*(?:token|secret|password|passwd|api_key|private_key)|(?:api|deploy|private)[ -]key)\s*(?:=|:|\bis\b)\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      (_match, prefix: string, value: string) =>
        `${prefix}${value.startsWith('"') || value.startsWith("'") ? `${value[0]}${MASK}${value[0]}` : MASK}`,
    )
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
      MASK,
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      MASK,
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, MASK)
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, (token) => (highEntropy(token) ? MASK : token));
}

function highEntropy(token: string): boolean {
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  return (
    [...counts.values()].reduce(
      (sum, count) => sum - (count / token.length) * Math.log2(count / token.length),
      0,
    ) >= 4
  );
}

/** Node env files need not be inherited by VISP, so collect their values before the child runs. */
export async function outputRedactor(root: string, declared: readonly string[] = []) {
  const files = new ProjectFileSystem(root);
  const entries = await files.listEntries(".");
  const paths = new Set([
    ...declared,
    ...(entries.ok
      ? entries.value
          .filter((entry) => entry.type === "file" && /^\.env(?:\.|$)/.test(entry.name))
          .map((entry) => entry.name)
      : []),
  ]);
  const values: string[] = [];
  for (const path of paths) {
    const metadata = await files.readMetadata(path);
    if (!metadata.ok || metadata.value?.type !== "file" || metadata.value.size > 1024 * 1024)
      continue;
    const text = await files.readText(path);
    if (!text.ok) continue;
    values.push(...envValues(text.value));
  }
  return (text: string) => redactText(text, { root, values });
}

export function redactStrings<T>(value: T, root: string): T {
  if (typeof value === "string") return redactText(value, { root }) as T;
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, root)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item, root)]),
    ) as T;
  return value;
}

function sensitiveValue(name: string, value: string | undefined): boolean {
  return !!value && (value.length >= 8 || SECRET_NAME.test(name));
}

function envValues(text: string): string[] {
  try {
    return Object.entries(parseEnv(text))
      .filter(([name, value]) => sensitiveValue(name, value))
      .map(([, value]) => value as string);
  } catch {
    return [];
  }
}
