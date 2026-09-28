import { vispError } from "../../core/errors.js";
import { run } from "../../core/exec.js";
import { err, ok, type Result } from "../../core/result.js";

/** A readable ordinal and goal; production allocation reserves the ordinal across refs. */
export function nextFeatureId(existing: readonly string[], goal: string): string {
  const highest = existing.reduce((max, name) => {
    const ordinal = Number.parseInt(name.split("-")[0] ?? "", 10);
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

/** Shared Git refs serialize allocation across linked worktrees without changing a branch. */
export async function allocateFeatureId(root: string, existing: readonly string[], goal: string) {
  const found = await featureNamesAcrossRefs(root);
  if (!found.ok) return found;
  const names = [...existing, ...found.value];
  for (let attempt = 0; attempt < 100; attempt++) {
    const reserved = await run(
      "git",
      ["for-each-ref", "--format=%(refname:strip=3)", "refs/visp/feature-ids/"],
      { cwd: root },
    );
    if (!reserved.ok) return reserved;
    if (reserved.value.exitCode !== 0)
      return err(vispError("COMMAND_FAILED", "Cannot inspect reserved feature IDs"));
    const id = nextFeatureId([...names, ...reserved.value.stdout.trim().split("\n")], goal);
    const claimed = await run(
      "git",
      ["update-ref", `refs/visp/feature-ids/${id.split("-")[0]}`, "HEAD", ""],
      { cwd: root },
    );
    if (!claimed.ok) return claimed;
    if (claimed.value.exitCode === 0) return ok(id);
  }
  return err(
    vispError("COMMAND_FAILED", "Cannot reserve a feature ID; retry when Git ref writers are idle"),
  );
}

async function featureNamesAcrossRefs(root: string): Promise<Result<string[]>> {
  const refs = await run("git", ["for-each-ref", "--format=%(objectname)"], { cwd: root });
  if (!refs.ok) return refs;
  if (refs.value.exitCode !== 0)
    return err(vispError("COMMAND_FAILED", "Cannot inspect feature branches"));
  const names: string[] = [];
  for (const commit of new Set(refs.value.stdout.trim().split("\n").filter(Boolean))) {
    const tree = await run("git", ["ls-tree", "--name-only", `${commit}:.visp/features`], {
      cwd: root,
    });
    if (!tree.ok) return tree;
    if (tree.value.exitCode === 0) names.push(...tree.value.stdout.trim().split("\n"));
  }
  return ok(names);
}
