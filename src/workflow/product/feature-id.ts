/** `001-add-login`: a zero-padded ordinal and a slug of the goal. */
export function nextFeatureId(existing: readonly string[], goal: string): string {
  const highest = existing.reduce((max, name) => {
    const ordinal = Number.parseInt(name.slice(0, 3), 10);
    return Number.isNaN(ordinal) ? max : Math.max(max, ordinal);
  }, 0);

  return `${String(highest + 1).padStart(3, "0")}-${slugify(goal)}`;
}

export function slugify(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return slug === "" ? "feature" : slug;
}
