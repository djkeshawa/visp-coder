import { fromUnknown, vispError } from "../../core/errors.js";
import { sha256 } from "../../core/hash.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { assertReviewSourceBudget, deliveredSources } from "./review-source-delivery.js";
import type { ProductSource } from "./sources.js";
/** Verify current file identity, preserving bounded review excerpts and their cutoff disclosures. */
export async function independentSources(
  workspace: WorkspaceState,
  input: readonly ProductSource[],
  understanding = false,
  authoredBrief = false,
) {
  const sources = [];
  const fullText = new Map<string, string>();
  for (const source of input.filter((entry) =>
    includeSource(entry, understanding, authoredBrief),
  )) {
    if (source.kind === "authored-brief" && understanding) {
      sources.push({ ...source, excerpt: "The proposed design is supplied once in design.brief." });
    } else if (source.available && ["implementation-file", "pinned-file"].includes(source.kind)) {
      const delivered = await sourceBytes(workspace, source, understanding);
      if (!delivered.ok) return delivered;
      sources.push(delivered.value.source);
      fullText.set(source.id, delivered.value.fullText);
    } else sources.push(source);
  }
  try {
    if (understanding) assertReviewSourceBudget(sources);
    return ok(understanding ? sources : await deliveredSources(sources, fullText));
  } catch (cause) {
    return err(fromUnknown(cause, "EVIDENCE_FAILED"));
  }
}

async function sourceBytes(
  workspace: WorkspaceState,
  source: ProductSource,
  understanding: boolean,
) {
  const content = await workspace.files.readBytesIfExists(source.reference);
  if (!content.ok) return content;
  if (!content.value || sha256(content.value) !== source.sha256)
    return err(
      vispError("EVIDENCE_FAILED", `Source changed while preparing review: ${source.reference}`),
    );
  const fullText = Buffer.from(content.value).toString("utf8");
  if (!understanding)
    return ok({
      fullText,
      source: {
        ...source,
        truncated:
          source.truncated ||
          (source.omittedRegions?.length ?? 0) > 0 ||
          source.excerpt.length < fullText.length,
        omittedRegions:
          source.omittedRegions ??
          (source.excerpt.length < fullText.length
            ? [
                "Source outside the bounded excerpt was omitted; its behavior cannot be assessed from this source",
              ]
            : []),
      },
    });
  return ok({
    fullText,
    source: {
      ...source,
      excerpt: fullText,
      truncated: false,
      omittedRegions: [],
      nextRead: undefined,
    },
  });
}

function includeSource(source: ProductSource, understanding: boolean, authoredBrief: boolean) {
  return understanding
    ? source.kind !== "implementation-file" || source.available
    : authoredBrief || source.kind !== "authored-brief";
}
