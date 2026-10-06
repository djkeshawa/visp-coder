/** Append without spreading: one call takes only so many arguments before the stack overflows. */
export function appendAll<T>(target: T[], items: Iterable<T>): void {
  for (const item of items) target.push(item);
}
