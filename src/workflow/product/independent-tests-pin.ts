import { join } from "node:path";
import { vispError } from "../../core/errors.js";
import { applyFileTransaction, filePrecondition } from "../../core/file-transaction.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { err } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { updateProductBrief } from "./brief.js";
import { sleep } from "./independent-tests-model.js";
import { retryBusy } from "./independent-tests-record.js";
import { type ProductRecord, readProductRecord } from "./store.js";

export async function pinTests(
  workspace: WorkspaceState,
  feature: string,
  path: string,
  command: string[],
  content: string,
) {
  // The worker may revise the brief meanwhile; never overwrite a concurrent revision.
  for (let attempt = 0; ; attempt += 1) {
    const current = await readProductRecord(workspace, { feature });
    if (!current.ok) return current;
    // Accepted work is not reopened by tests that arrive afterwards.
    if (current.value.state.status === "accepted")
      return err(
        vispError("STAGE_BLOCKED", "The feature was accepted before the tests were ready"),
      );
    const pinned = await pinOnto(workspace, current.value.brief, path, command, content);
    if (pinned.ok || pinned.error.code !== "STATE_BUSY" || attempt >= 8) return pinned;
    await sleep(500);
  }
}

function pinOnto(
  workspace: WorkspaceState,
  brief: ProductRecord["brief"],
  path: string,
  command: string[],
  content: string,
) {
  return updateProductBrief(workspace, {
    feature: brief.feature,
    expectedBriefDigest: hashValue(brief),
    brief: {
      ...brief,
      acceptanceBaseline: [
        ...brief.acceptanceBaseline,
        { command, files: [{ path, sha256: sha256(content) }] },
      ],
    },
    intentChange: {
      reason: "Pin acceptance tests an independent tester wrote from the original request",
      provenance: "visp-tester",
    },
  });
}

export async function removeFile(workspace: WorkspaceState, path: string, content: string) {
  await retryBusy(() =>
    applyFileTransaction(workspace.paths.root, "discard-acceptance-tests", [
      {
        kind: "remove",
        path: join(workspace.paths.root, path),
        expectedBefore: filePrecondition(content),
      },
    ]),
  );
}
