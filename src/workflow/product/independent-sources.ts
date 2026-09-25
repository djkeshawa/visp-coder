import { vispError } from "../../core/errors.js";
import { sha256 } from "../../core/hash.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import type { ProductSource } from "./sources.js";
/** Deliver the selected source bytes intact, verifying they still match the evidence identity. */
export async function independentSources(
  workspace: WorkspaceState,
  input: readonly ProductSource[],
  understanding = false,
) {
  const sources = [];
  for (const source of input.filter((entry) => includeSource(entry, understanding))) {
    if (source.kind === "authored-brief") {
      sources.push({ ...source, excerpt: "The proposed design is supplied once in design.brief." });
    } else if (source.available && ["implementation-file", "pinned-file"].includes(source.kind)) {
      const delivered = await sourceBytes(workspace, source);
      if (!delivered.ok) return delivered;
      sources.push(delivered.value);
    } else sources.push(source);
  }
  return ok(sources);
}

async function sourceBytes(workspace: WorkspaceState, source: ProductSource) {
  const content = await workspace.files.readBytesIfExists(source.reference);
  if (!content.ok) return content;
  if (!content.value || sha256(content.value) !== source.sha256)
    return err(
      vispError("EVIDENCE_FAILED", `Source changed while preparing review: ${source.reference}`),
    );
  return ok({
    ...source,
    excerpt: Buffer.from(content.value).toString("utf8"),
    truncated: false,
    omittedRegions: [],
    nextRead: undefined,
  });
}

function includeSource(source: ProductSource, understanding: boolean) {
  return understanding
    ? source.kind !== "implementation-file" || source.available
    : source.kind !== "authored-brief";
}
