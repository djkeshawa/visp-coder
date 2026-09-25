import ignore from "ignore";

type Matcher = ReturnType<typeof ignore>;

interface Scope {
  /** Repository-relative directory the rules were written in; "" for the root. */
  readonly dir: string;
  readonly matcher: Matcher;
}

/**
 * `.gitignore` semantics are per-directory: a rule only applies to paths beneath
 * the file that declared it, and a nested file may re-include what a parent hid.
 */
export class IgnoreStack {
  private constructor(private readonly scopes: readonly Scope[]) {}

  static empty(): IgnoreStack {
    return new IgnoreStack([]);
  }

  /** Returns a new stack; the receiver keeps applying to sibling branches. */
  extend(dir: string, gitignoreContent: string): IgnoreStack {
    if (gitignoreContent.trim() === "") return this;
    return new IgnoreStack([...this.scopes, { dir, matcher: ignore().add(gitignoreContent) }]);
  }

  ignores(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const scope of this.scopes) {
      const relative = relativeTo(scope.dir, path);
      if (relative === undefined) continue;
      const result = scope.matcher.test(isDirectory ? `${relative}/` : relative);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }
}

function relativeTo(dir: string, path: string): string | undefined {
  if (dir === "") return path;
  if (!path.startsWith(`${dir}/`)) return undefined;
  return path.slice(dir.length + 1);
}
