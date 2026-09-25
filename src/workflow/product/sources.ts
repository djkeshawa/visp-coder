import { sha256 } from "../../core/hash.js";
import type { WorkspaceState } from "../state.js";
import type { ProductOutcome } from "./model.js";
import type { ProductRecord } from "./store.js";

export interface ProductSource {
  readonly id: string;
  readonly kind: "preserved-request" | "pinned-file" | "implementation-file" | "authored-brief";
  readonly reference: string;
  readonly sha256: string;
  readonly available: boolean;
  readonly excerpt: string;
  readonly omittedRegions?: readonly string[];
  readonly nextRead?: string;
}

/** Source identity is observed by VISP. Authorship and human approval are not authenticated. */
export async function productSources(workspace: WorkspaceState, record: ProductRecord) {
  const request = record.state.intentSnapshot.originalRequest;
  const sources: ProductSource[] = [
    {
      id: "SRC-REQUEST",
      kind: "preserved-request",
      reference: "Preserved original request",
      sha256: sha256(request),
      available: true,
      excerpt: request.slice(0, 4000),
    },
  ];
  const contents = new Map([["SRC-REQUEST", request]]);
  const briefId = `BRIEF-${sha256(record.briefText).slice(0, 16)}`;
  sources.push({
    id: briefId,
    kind: "authored-brief",
    reference: "Current authored brief; proposed intent and design, not execution evidence",
    sha256: sha256(record.briefText),
    available: true,
    excerpt: record.briefText,
  });
  contents.set(briefId, record.briefText);
  const seen = new Set<string>();
  for (const file of record.brief.acceptanceBaseline.flatMap((entry) => entry.files)) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const content = await workspace.files.readBytesIfExists(file.path);
    const bytes = content.ok ? content.value : undefined;
    const id = `SRC-${sha256(`${file.path}:${file.sha256}`).slice(0, 16)}`;
    const text = bytes ? Buffer.from(bytes).toString("utf8") : "";
    contents.set(id, text);
    sources.push({
      id,
      kind: "pinned-file",
      reference: file.path,
      sha256: file.sha256,
      available: bytes !== undefined && sha256(bytes) === file.sha256,
      excerpt: text.slice(0, 2000),
    });
  }
  const claims = sourceClaims(record.brief.outcomes, sources, contents);
  return { sources, claims };
}

export function sourceClaims(
  outcomes: readonly ProductOutcome[],
  sources: readonly ProductSource[],
  contents: ReadonlyMap<string, string>,
) {
  return outcomes.flatMap((outcome) =>
    [outcome, ...outcome.expectations].map((claim) => {
      const source = claimSource(claim, sources, contents);
      return {
        outcome: outcome.id,
        id: claim.id,
        reportedProvenance: claim.provenance,
        ...(source ? { source: source.id } : {}),
        sourceStatus: !source
          ? ("unsubstantiated" as const)
          : source.available
            ? ("identified" as const)
            : ("unavailable" as const),
        qualification:
          "A source reference identifies supplied material; it does not authenticate authorship, independence or human approval.",
      };
    }),
  );
}

function claimSource(
  claim: { source?: string; sourceQuote?: string },
  sources: readonly ProductSource[],
  contents: ReadonlyMap<string, string>,
): ProductSource | undefined {
  const id = claim.source ?? (claim.sourceQuote ? "SRC-REQUEST" : undefined);
  const source = sources.find((entry) => entry.id === id);
  if (!source?.available || !claim.sourceQuote) return source;
  return contents.get(source.id)?.includes(claim.sourceQuote) ? source : undefined;
}
