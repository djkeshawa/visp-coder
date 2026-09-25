import { z } from "zod";
import { HARNESSES, PROFILES } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import type { ProjectFileSystem } from "../core/fs.js";
import { HOOK_KINDS } from "../core/input.js";
import type { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import { identifiedRuntimeSchema } from "../core/runtime-agreement.js";

const installStateSchema = z
  .object({
    kind: z.literal("install-state"),
    version: z.literal(1),
    harness: z.enum(HARNESSES),
    profile: z.enum(PROFILES),
    hooks: z.array(z.enum(HOOK_KINDS)),
    mcp: z.boolean(),
    runtime: identifiedRuntimeSchema.optional(),
  })
  .strict();

export type InstallState = z.infer<typeof installStateSchema>;

export async function readInstallState(
  paths: ProjectPaths,
  files: ProjectFileSystem,
): Promise<Result<InstallState | undefined>> {
  return files.readJsonIfExists(paths.installState, (value) => {
    const parsed = installStateSchema.safeParse(value);
    return parsed.success
      ? ok(parsed.data)
      : err(vispError("ARTIFACT_INVALID", `Invalid install state: ${parsed.error.message}`));
  });
}

export function installStateText(state: InstallState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
