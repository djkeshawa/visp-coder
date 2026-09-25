import { z } from "zod";
import { hashValue } from "../../core/hash.js";
import { DRAG_DEFAULTS, POINTER_TRAVEL_DEFAULTS } from "../../testing/browser-gestures.js";
import type { BrowserJourney } from "../../testing/browser-journey.js";
import type { ProductReviewCapture } from "./product-review.js";

/** Capture bookkeeping and deadlines may vary; gesture timing is part of the behavior. */
export function productJourneyKey(journey: BrowserJourney, task?: string): string {
  return `journey-v3:${hashValue({
    url: journey.url,
    viewport: journey.viewport ?? { width: 1280, height: 720 },
    task,
    actions: journey.actions.map(journeyActionIdentity),
  })}`;
}

function journeyActionIdentity(action: BrowserJourney["actions"][number]) {
  const identity = Object.fromEntries(
    Object.entries(action).filter(
      ([key]) => !["capture", "timeoutMs", "captureDuring"].includes(key),
    ),
  );
  if (action.kind === "drag")
    return {
      ...identity,
      input: action.input ?? DRAG_DEFAULTS.input,
      cancel: action.cancel ?? DRAG_DEFAULTS.cancel,
      steps: action.steps ?? DRAG_DEFAULTS.steps,
      durationMs: action.durationMs ?? DRAG_DEFAULTS.durationMs,
    };
  if (action.kind === "move")
    return {
      ...identity,
      steps: action.steps ?? POINTER_TRAVEL_DEFAULTS.steps,
      durationMs: action.durationMs ?? POINTER_TRAVEL_DEFAULTS.durationMs,
    };
  return identity;
}

const recordedCapture = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  subjectDigest: z.string(),
  provenance: z.literal("runner-captured"),
});
const recordedOperation = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "navigate",
    "measure",
    "observe",
    "scroll",
    "pointer",
    "touch",
    "keyboard",
    "capture",
  ]),
  completedAt: z.string().min(1),
  captureId: z.string().optional(),
});
const captureRunSchema = z.object({
  id: z.string().optional(),
  version: z.union([z.literal(1), z.literal(2)]),
  status: z.enum(["completed", "failed", "timed-out", "cancelled"]).optional(),
  provenance: z.literal("runner-executed"),
  subjectDigest: z.string(),
  captures: z.array(recordedCapture),
  operations: z.array(recordedOperation),
});
type CaptureRun = z.infer<typeof captureRunSchema>;

/** Input execution and before/after pixels establish a journey was observed, never its quality. */
export function productJourneyGaps(options: {
  readonly subjectDigest: string;
  readonly captureRuns: readonly unknown[];
  readonly images: readonly ProductReviewCapture[];
  readonly linkedEvidence: readonly string[];
}): string[] {
  const linked = new Set(options.linkedEvidence);
  const images = options.images.filter(
    (image) =>
      image.subjectDigest === options.subjectDigest &&
      image.provenance === "runner-captured" &&
      (linked.has(image.id) || linked.has(image.path)),
  );
  let unlinkedPair: string[] | undefined;
  for (const candidate of options.captureRuns) {
    const parsed = captureRunSchema.safeParse(candidate);
    if (
      !parsed.success ||
      parsed.data.subjectDigest !== options.subjectDigest ||
      (parsed.data.version === 2 && parsed.data.status !== "completed")
    )
      continue;
    if (observedJourneyPair(parsed.data, images)) return [];
    unlinkedPair ??= observedJourneyPair(
      parsed.data,
      options.images.filter(
        (image) =>
          image.subjectDigest === options.subjectDigest && image.provenance === "runner-captured",
      ),
    );
  }
  if (unlinkedPair)
    return [
      `A before/input/after journey is already available in this review selection. Cite its execution ID so VISP can link the images, or cite ${unlinkedPair.join(" and ")}. No recapture is needed for this linking gap; the reviewer still supplies the quality judgment.`,
    ];
  return [
    "A current runner-executed interaction journey with linked captures before and after an input is required; a navigation-only screenshot or reported interaction does not establish this evidence",
  ];
}

/** Resolve only a tool-recorded run to images already selected and byte-validated for this review. */
export function productJourneyImageLinks(options: {
  readonly subjectDigest: string;
  readonly captureRuns: readonly unknown[];
  readonly images: readonly ProductReviewCapture[];
  readonly runIds: ReadonlySet<string>;
}): string[] {
  const images = options.images.filter(
    (image) =>
      image.subjectDigest === options.subjectDigest && image.provenance === "runner-captured",
  );
  const links: string[] = [];
  for (const candidate of options.captureRuns) {
    const parsed = captureRunSchema.safeParse(candidate);
    if (
      !parsed.success ||
      !parsed.data.id ||
      !options.runIds.has(parsed.data.id) ||
      parsed.data.subjectDigest !== options.subjectDigest ||
      (parsed.data.version === 2 && parsed.data.status !== "completed")
    )
      continue;
    const pair = observedJourneyPair(parsed.data, images);
    if (pair) links.push(...pair);
  }
  return [...new Set(links)];
}

function observedJourneyPair(
  run: CaptureRun,
  images: readonly ProductReviewCapture[],
): string[] | undefined {
  const available = new Set(
    run.captures
      .filter(
        (capture) =>
          capture.subjectDigest === run.subjectDigest &&
          images.some(
            (image) =>
              image.id === capture.id &&
              image.path === capture.path &&
              image.sha256 === capture.sha256,
          ),
      )
      .map((capture) => capture.id),
  );
  if (new Set(run.operations.map((operation) => operation.id)).size !== run.operations.length)
    return undefined;
  const before = new Set<string>();
  let interacted = false;
  for (const operation of run.operations) {
    if (["pointer", "touch", "keyboard"].includes(operation.kind) && before.size > 0)
      interacted = true;
    if (operation.kind !== "capture" || !operation.captureId || !available.has(operation.captureId))
      continue;
    const initial = [...before].find((id) => id !== operation.captureId);
    if (interacted && initial) return [initial, operation.captureId];
    before.add(operation.captureId);
  }
  return undefined;
}
