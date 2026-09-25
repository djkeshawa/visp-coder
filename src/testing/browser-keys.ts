import { z } from "zod";

const SPECIAL_KEYS: Readonly<Record<string, number>> = {
  Tab: 9,
  Enter: 13,
  Space: 32,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};
export const browserKeySchema = z
  .string()
  .refine(
    (key) => Object.hasOwn(SPECIAL_KEYS, key) || /^[a-zA-Z0-9]$/.test(key),
    "Use Tab, Enter, Space, Escape, an arrow, or one ASCII letter/digit",
  );
export function browserKey(key: string) {
  const parsed = browserKeySchema.safeParse(key);
  if (!parsed.success) throw new Error(`Unsupported browser key ${key}`);
  const special = SPECIAL_KEYS[key];
  const letter = /^[a-z]$/i.test(key);
  return {
    key: key === "Space" ? " " : key,
    code: special ? key : letter ? `Key${key.toUpperCase()}` : `Digit${key}`,
    windowsVirtualKeyCode: special ?? key.toUpperCase().charCodeAt(0),
    ...(letter && key === key.toUpperCase() ? { modifiers: 8 } : {}),
    text: key === "Enter" ? "\r" : key === "Space" ? " " : special ? undefined : key,
  };
}
