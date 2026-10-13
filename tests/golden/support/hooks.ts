import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** The host session every hook input names. */
export const SESSION = "golden-session";

/** Runs an installed hook script as its host does: the event as JSON on stdin, from the project. */
export function runHook(
  root: string,
  script: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): string {
  const result = spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return [
    `> ${script} ${JSON.stringify(input)}`,
    "--- stdout",
    result.stdout,
    "--- stderr",
    result.stderr,
    `--- exit ${result.status}`,
  ].join("\n");
}
