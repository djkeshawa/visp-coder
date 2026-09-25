import { vispError } from "../../core/errors.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import type { CriticPhase, CriticState } from "./critic-model.js";
import type { CriticSelection } from "./critic-store.js";
import { needsBrowser } from "./environment.js";
import { findingAppliesToSlice, outstandingFeedback } from "./findings.js";
import { independentReviewJsonSchema, independentReviewTemplate } from "./independent-review.js";
import { independentSources } from "./independent-sources.js";
import type { ProductBrief } from "./model.js";
import { deliveredReviewEvidenceIds } from "./review-context.js";
import {
  SOURCE_ADVICE_INSTRUCTIONS,
  UNDERSTANDING_CRITIC_INSTRUCTIONS,
} from "./review-instructions.js";
import { independentReviewerContext, type runProductReviewerHandoff } from "./reviewer-handoff.js";

type Handoff = Extract<
  Awaited<ReturnType<typeof runProductReviewerHandoff>>,
  { ok: true }
>["value"];
export interface CriticPacket {
  phase?: CriticPhase;
  question: string;
  sourceOnly?: boolean;
  selection: NonNullable<Handoff["submission"]["selection"]>;
  instructions: string;
  current: Omit<ReturnType<typeof independentReviewerContext>, "instructions">;
  design?: { brief: ProductBrief; selectedSlice: string | undefined; provenance: string };
  /**
   * Earlier independent findings for this selection. They are reviewer judgments, not the
   * worker's claims; without their IDs no later review could resolve them.
   */
  openFindings?: readonly { id: string; problem: string; nextCheck: string }[];
  responseShape: ReturnType<typeof independentReviewTemplate>;
  responseSchema: ReturnType<typeof independentReviewJsonSchema>;
}

const OPEN_FINDINGS_INSTRUCTIONS =
  "openFindings lists problems an earlier independent review reported. Re-check each against the current source and evidence. If it is fixed, add a resolutions entry with its id, what changed, and the current passing check evidence IDs that exercise it. If it is not fixed, report it again as a finding.";

function packetInstructions(
  product: string,
  sourceOnly: boolean,
  understanding: boolean,
  openFindings: number,
) {
  if (sourceOnly) return SOURCE_ADVICE_INSTRUCTIONS;
  if (understanding) return UNDERSTANDING_CRITIC_INSTRUCTIONS;
  return openFindings ? `${product}\n${OPEN_FINDINGS_INSTRUCTIONS}` : product;
}

function openFindingsFor(selected: CriticSelection) {
  return outstandingFeedback(selected.record)
    .filter(
      (finding) => finding.phase === "product" && findingAppliesToSlice(finding, selected.slice),
    )
    .slice(0, 6)
    .map((finding) => ({ id: finding.id, problem: finding.problem, nextCheck: finding.nextCheck }));
}

/** Independent input: no worker verdicts, approval history, workflow plans or approval forms. */
export async function criticPacket(
  workspace: WorkspaceState,
  selected: CriticSelection,
  state: CriticState,
  current: Handoff,
  question?: string,
  sourceOnly = false,
) {
  const understanding = selected.phase === "understanding";
  const sources = await independentSources(workspace, current.sources, understanding);
  if (!sources.ok) return sources;
  // Product-review guidance must not leak into design or source-only consultations.
  const { instructions: _instructions, ...independent } = independentReviewerContext(current);
  // Select usable references once, before generating the provider schema.
  const evidence = current.evidence.filter(
    (entry) =>
      entry.status !== "not-delivered" &&
      (!entry.id.startsWith("BRIEF-") || understanding) &&
      (!sourceOnly || entry.kind !== "image"),
  );
  const open = understanding || sourceOnly ? [] : openFindingsFor(selected);
  const packet: CriticPacket = {
    phase: selected.phase,
    ...(sourceOnly ? { sourceOnly: true } : {}),
    question:
      question ??
      (understanding
        ? "Does this proposed approach fulfill the original request? Identify consequential assumptions before implementation."
        : "Does this implementation fulfill the original request? What consequential problems can you observe?"),
    selection: sourceOnly
      ? { ...current.submission.selection, images: [] }
      : current.submission.selection,
    instructions: packetInstructions(current.instructions, sourceOnly, understanding, open.length),
    ...(open.length ? { openFindings: open } : {}),
    current: {
      ...independent,
      sources: sources.value,
      ...(sourceOnly ? { images: [], observationSequence: undefined } : {}),
      evidence,
    },
    ...(understanding
      ? {
          design: {
            brief: selected.record.brief,
            selectedSlice: selected.slice?.id,
            provenance:
              "Actor proposal; inspect against the original request, not independent approval",
          },
        }
      : {}),
    responseShape: independentReviewTemplate(),
    responseSchema: independentReviewJsonSchema(
      deliveredReviewEvidenceIds(evidence, independent.interactionEvidence),
      independent.outcomes.map((outcome) => outcome.id),
    ),
  };
  if (
    packet.current.images.reduce(
      (bytes, image) => bytes + Buffer.byteLength(image.data, "base64"),
      0,
    ) > state.config.maxImageBytes
  )
    return err(
      vispError(
        "STAGE_BLOCKED",
        "Current review images exceed the configured budget; select representative states before dispatch. No call spent.",
      ),
    );
  return ok(packet);
}

export function packetHasImages(packet: CriticPacket): boolean {
  return packet.current.images.length > 0;
}

/** A UI review needs current evidence; old candidates never establish review readiness. */
export function currentReviewGap(packet: CriticPacket, selected: CriticSelection) {
  if (selected.phase === "understanding") return undefined;
  if (packet.sourceOnly)
    return packet.current.sources.some(
      (source) => source.kind === "implementation-file" && source.available,
    )
      ? undefined
      : "Source advice needs current implementation source; no call spent.";
  const ui = needsBrowser(selected.record.brief, selected.slice);
  return ui && !packetHasImages(packet)
    ? "Current UI images are missing or stale. Capture the affected current behavior before product critique; no call spent. Implementation can continue."
    : undefined;
}

export { SOURCE_ADVICE_LIMITATION } from "./review-instructions.js";
