import { sha256 } from "../../../src/core/hash.js";
import type { ProductReviewCapture } from "../../../src/workflow/evidence/product-review.js";
import { readProductRecord, saveProductState } from "../../../src/workflow/product/store.js";
import { productSourceDigest } from "../../../src/workflow/product/subject.js";
import { pngHeader, type TestWorkspace } from "./workspace.js";

/** Recorded runner fixture; actual browser execution is covered by browser-session integration tests. */
export async function recordedProductJourney(
  workspace: TestWorkspace,
  id: string,
): Promise<ProductReviewCapture[]> {
  const state = await workspace.state();
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error("Cannot prepare current journey fixture");
  const subject = await productSourceDigest(state, record.value.brief);
  if (!subject.ok) throw new Error("Cannot prepare current journey fixture");
  const bytes = pngHeader(640, 480),
    createdAt = new Date().toISOString();
  const captures: ProductReviewCapture[] = [];
  for (const stage of ["before", "after"]) {
    const path = `.visp/reports/${id}-${stage}.png`;
    await workspace.write(path, bytes);
    captures.push({
      id: `${id}-${stage}`,
      path,
      sha256: sha256(bytes),
      subjectDigest: subject.value,
      route: "/Start",
      steps: stage === "before" ? ["Open /Start"] : ["Open /Start", "Click Begin"],
      viewport: { width: 640, height: 480 },
      createdAt,
      provenance: "runner-captured",
    });
  }
  const run = {
    version: 1,
    provenance: "runner-executed",
    subjectDigest: subject.value,
    captures,
    operations: [
      {
        id: `${id}-capture-before`,
        kind: "capture",
        captureId: captures[0]?.id,
        completedAt: createdAt,
      },
      { id: `${id}-input`, kind: "pointer", completedAt: createdAt },
      {
        id: `${id}-capture-after`,
        kind: "capture",
        captureId: captures[1]?.id,
        completedAt: createdAt,
      },
    ],
  };
  const saved = await saveProductState(state, record.value, {
    ...record.value.state,
    captures: [...record.value.state.captures, ...captures],
    captureRuns: [...record.value.state.captureRuns, run],
  });
  if (!saved.ok) throw new Error(saved.error.message);
  return captures;
}
