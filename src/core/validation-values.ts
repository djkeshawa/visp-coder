export function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function object(value: unknown, name: string): Record<string, unknown> {
  const result = optionalObject(value);
  if (!result) throw new Error(`${name} must be an object`);
  return result;
}
export function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}
export function amount(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be finite and nonnegative`);
  return value;
}
export function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length)
    throw new Error(`${name} must be a nonempty string`);
  return value;
}
