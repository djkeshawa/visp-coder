import { z } from "zod";
import { browserComparisonSchema } from "../../testing/browser-comparison.js";

const observation = z.object({
  expected: z.union([
    browserComparisonSchema,
    z.object({
      selector: z.string(),
      text: z.string().optional(),
      attribute: z.object({ name: z.string(), value: z.string().nullable() }).optional(),
      visibility: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  ]),
  actual: z.unknown(),
  matched: z.boolean(),
});

/** Preserve the assertion and observed value together; do not infer behavior from labels. */
export function summarizeObservation(entry: {
  id: string;
  measurement?: { json: string; truncated: boolean };
}) {
  if (!entry.measurement || entry.measurement.truncated)
    return {
      id: entry.id,
      status: "unavailable",
      limitation: "Observation details are missing or truncated; inspect the original run.",
    };
  try {
    const parsed = observation.safeParse(JSON.parse(entry.measurement.json));
    if (parsed.success)
      return {
        id: entry.id,
        status: parsed.data.matched ? "matched" : "not-matched",
        expected: boundedSummary(parsed.data.expected),
        actual: boundedSummary(parsed.data.actual),
        limitation:
          "Only these recorded values were compared. This does not establish correct motion, repeated use, alternate endings or recovery. Judge those against the promised behavior and relevant execution evidence.",
      };
  } catch {
    /* Historical malformed measurement remains unavailable. */
  }
  return {
    id: entry.id,
    status: "unavailable",
    limitation: "Observation details could not be parsed.",
  };
}

const size = z.object({
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
const layout = z.object({
  kind: z.literal("rendered-layout"),
  captureId: z.string(),
  result: z.object({
    version: z.literal(1),
    viewport: size,
    canvases: z
      .array(
        z.object({
          element: z.string().max(100),
          viewportAreaFraction: z.number().min(0).max(1).optional(),
          intrinsic: size,
          content: size,
          scaleRatio: z.number().finite().nonnegative().nullable(),
        }),
      )
      .max(4),
    controls: z
      .array(
        z.object({
          element: z.string().max(100),
          width: z.number().finite().nonnegative(),
          height: z.number().finite().nonnegative(),
          inViewport: z.boolean(),
        }),
      )
      .max(12)
      .optional(),
    clipped: z
      .array(z.object({ element: z.string().max(100), visibleFraction: z.number().min(0).max(1) }))
      .max(8),
    omittedCanvases: z.number().int().nonnegative(),
    uninspectedElements: z.number().int().nonnegative(),
  }),
});

export function summarizeLayout(
  entry: { id: string; measurement?: { json: string; truncated: boolean } },
  captures: ReadonlySet<string>,
) {
  if (!entry.measurement || entry.measurement.truncated) return [];
  try {
    const parsed = layout.safeParse(JSON.parse(entry.measurement.json));
    if (!parsed.success || !captures.has(parsed.data.captureId)) return [];
    const result = parsed.data.result;
    return [
      {
        id: entry.id,
        captureId: parsed.data.captureId,
        ...result,
        usability: {
          offscreenControls:
            result.controls
              ?.filter((control) => !control.inViewport)
              .map((control) => control.element) ?? [],
          guidance:
            "Use canvas area and rendered control sizes to assess the primary activity. A proportional canvas can still be too small; inspect actual target size and overlay occlusion in the image. Scrolling or small secondary controls are not automatically defects.",
        },
        concerns: [
          ...result.canvases
            .filter(
              (canvas) => canvas.scaleRatio !== null && Math.abs(canvas.scaleRatio - 1) > 0.05,
            )
            .map(
              (canvas) =>
                `${canvas.element}: unequal horizontal/vertical canvas scaling (${canvas.scaleRatio?.toFixed(3)}). Inspect whether distortion is intended.`,
            ),
          ...result.clipped.map(
            (element) =>
              `${element.element}: ${Math.round(element.visibleFraction * 100)}% of its box is visible inside clipping/scrolling ancestors. Inspect text and control usability.`,
          ),
        ],
        limitation:
          "Measured immediately before the capture, not atomically with its pixels. Bounded geometry inspection does not assess aesthetics, text semantics, occlusion or all transformed elements; intentional crops and scroll regions are not automatically bugs.",
      },
    ];
  } catch {
    return [];
  }
}

function boundedSummary(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json && json.length > 800
    ? {
        preview: json.slice(0, 800),
        truncated: true,
        recovery: "Read this operation in the original capture run for full values",
      }
    : value;
}
