import { z } from "zod";
import { vispError } from "../core/errors.js";
import { withStateMutation } from "../core/file-transaction.js";
import { currentBranch } from "../core/git.js";
import { ok, type Result } from "../core/result.js";
import { runtimeIdentity } from "../core/version.js";
import { artifactEnvelope, isoTimestampSchema, now } from "../workflow/artifacts/common.js";
import type { WorkspaceState } from "../workflow/state.js";

/**
 * A durable record of what visp actually did. Without it, "the tool ran and
 * nothing happened" is indistinguishable from "the tool was never installed".
 */

const activitySchema = z
  .object({
    command: z.string(),
    outcome: z.enum(["ok", "refused", "error"]),
    detail: z.string().optional(),
    /** Advisory procedures actually delivered by this activity. */
    skills: z.array(z.string()).default([]),
    runtime: z
      .object({
        version: z.string(),
        buildId: z.string(),
        executable: z.string(),
      })
      .strict()
      .optional(),
    at: isoTimestampSchema,
  })
  .strict();

export type Activity = z.infer<typeof activitySchema>;

const sessionSchema = z
  .object({
    ...artifactEnvelope("session"),
    /** Sessions are per branch, so worktrees resume independently. */
    branch: z.string().optional(),
    feature: z.string().optional(),
    activity: z.array(activitySchema).default([]),
  })
  .strict();

export type Session = z.infer<typeof sessionSchema>;

const storeSchema = z
  .object({
    ...artifactEnvelope("sessions"),
    sessions: z.record(z.string(), sessionSchema).default({}),
  })
  .strict();

export async function readSession(state: WorkspaceState): Promise<Result<Session>> {
  const branch = await branchKey(state);
  const store = await readStore(state);
  if (!store.ok) return store;

  return ok(
    store.value[branch] ?? {
      kind: "session",
      createdAt: now(),
      branch,
      ...(state.status?.activeFeature ? { feature: state.status.activeFeature } : {}),
      activity: [],
    },
  );
}

/**
 * Appends one line of history. Best effort: recording that a command ran must
 * never be the reason a command fails.
 */
export async function recordActivity(
  state: WorkspaceState,
  entry: Omit<Activity, "at" | "skills"> & { readonly skills?: readonly string[] },
): Promise<void> {
  await withStateMutation(state.paths.root, async () => {
    const session = await readSession(state);
    if (!session.ok) return session;

    const updated: Session = {
      ...session.value,
      ...(state.status?.activeFeature ? { feature: state.status.activeFeature } : {}),
      activity: [
        ...session.value.activity,
        { ...entry, skills: [...(entry.skills ?? [])], runtime: runtimeIdentity(), at: now() },
      ],
    };

    const store = await readStore(state);
    if (!store.ok) return store;

    return state.files.writeJson(state.paths.session, {
      kind: "sessions",
      createdAt: now(),
      sessions: { ...store.value, [updated.branch ?? "default"]: updated },
    });
  });
}

async function readStore(state: WorkspaceState): Promise<Result<Record<string, Session>>> {
  const stored = await state.files.readJsonIfExists(state.paths.session, (value) => {
    const parsed = storeSchema.safeParse(value);
    return parsed.success
      ? ok(parsed.data)
      : { ok: false as const, error: vispError("ARTIFACT_INVALID", "Invalid session store") };
  });
  if (!stored.ok) return stored;
  return ok(stored.value?.sessions ?? {});
}

async function branchKey(state: WorkspaceState): Promise<string> {
  const branch = await currentBranch(state.paths.root);
  return branch.ok ? branch.value : "default";
}
