/// <reference lib="dom" />
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ProductReviewCapture } from "../workflow/evidence/product-review.js";
import { measureControl } from "./browser.js";
import { browserComparisonSchema, compareBrowserValues } from "./browser-comparison.js";
import { BrowserSecurityError, readBrowserFile } from "./browser-files.js";
import { DRAG_DEFAULTS } from "./browser-gestures.js";
import { browserKeySchema } from "./browser-keys.js";
import {
  BrowserBehaviorFailure,
  scrollToElement,
  waitForObservation,
} from "./browser-observations.js";
import { actAtPoint } from "./browser-points.js";
import {
  type BrowserOperation,
  type BrowserSession,
  openBrowserSession,
} from "./browser-session.js";
import { BrowserRuntimeError } from "./chrome-transport.js";
import { bounded } from "./deadline.js";

const viewport = z
  .object({
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
  })
  .strict();
const relativePoint = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
export const browserJourneySchema = z
  .object({
    url: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:", "file:"].includes(new URL(value).protocol),
        "Application URL must use HTTP(S) or a confined project file URL",
      ),
    viewport: viewport.optional(),
    actions: z
      .array(
        z.discriminatedUnion("kind", [
          browserComparisonSchema,
          z
            .object({
              kind: z.literal("wait"),
              durationMs: z.number().int().min(1).max(10000),
              capture: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              kind: z.literal("resize"),
              viewport,
              capture: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              kind: z.enum(["click", "tap"]),
              selector: z.string().min(1),
              position: relativePoint.optional(),
              capture: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              kind: z.literal("move"),
              selector: z.string().min(1),
              position: relativePoint.optional(),
              steps: z.number().int().min(1).max(60).optional(),
              durationMs: z.number().min(0).max(2000).optional(),
              capture: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              kind: z.literal("scroll"),
              selector: z.string().min(1),
              block: z.enum(["start", "center", "end", "nearest"]).optional(),
              timeoutMs: z.number().int().min(1).max(10000).optional(),
              capture: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              kind: z.literal("key"),
              key: browserKeySchema,
              capture: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              kind: z.literal("drag"),
              selector: z.string().min(1),
              from: z
                .object({ x: z.number().finite(), y: z.number().finite() })
                .strict()
                .optional(),
              to: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
              input: z.enum(["pointer", "touch"]).optional(),
              cancel: z.boolean().optional(),
              steps: z.number().int().min(2).max(60).optional(),
              durationMs: z.number().min(0).max(2000).optional(),
              captureDuring: z.boolean().optional(),
              capture: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              kind: z.literal("wait-for"),
              text: z.string().max(2048).optional(),
              visibility: z.enum(["visible", "hidden", "absent"]).optional(),
              enabled: z.boolean().optional(),
              attribute: z
                .object({
                  name: z.string().min(1).max(256),
                  value: z.string().max(2048).nullable(),
                })
                .strict()
                .optional(),
              timeoutMs: z.number().int().min(1).max(10000).optional(),
              selector: z.string().min(1),
              capture: z.boolean().default(false),
            })
            .strict(),
        ]),
      )
      .max(50)
      .default([]),
  })
  .strict()
  .superRefine((journey, context) => {
    const captures =
      1 +
      journey.actions.filter((action) => action.capture).length +
      journey.actions.filter((action) => action.kind === "drag" && action.captureDuring).length +
      (journey.actions.length > 0 && !journey.actions.at(-1)?.capture ? 1 : 0);
    if (captures > 6)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actions"],
        message: "Journey exceeds six representative captures",
      });
    journey.actions.forEach((action, index) => {
      if (action.kind === "drag" && action.cancel && action.input !== "touch")
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions", index, "cancel"],
          message: "Native gesture cancellation requires touch input",
        });
      if (
        action.kind === "compare" &&
        action.mode === "text" &&
        ["less-than", "greater-than"].includes(action.relation)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions", index, "mode"],
          message: "Ordered comparisons require number mode",
        });
      if (
        action.kind === "wait-for" &&
        action.visibility === "absent" &&
        (action.text !== undefined ||
          action.attribute !== undefined ||
          action.enabled !== undefined)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions", index],
          message: "An absent element cannot also have text, attributes or enabled state",
        });
    });
  });
export type BrowserJourney = z.infer<typeof browserJourneySchema>;

export interface BrowserJourneyFailure {
  readonly kind: "behavior" | "environment";
  readonly message: string;
  readonly actionIndex?: number;
  readonly operationId?: string;
  readonly diagnosticGaps?: readonly string[];
}
export interface BrowserJourneyResult {
  readonly status: "completed" | "failed" | "timed-out" | "cancelled";
  readonly failure?: BrowserJourneyFailure;
  readonly captures: ProductReviewCapture[];
  readonly operations: readonly BrowserOperation[];
}

/** Fixed browser actions execute in VISP, not in an agent-authored evidence reporter. */
export async function runBrowserJourney(options: {
  readonly journey: BrowserJourney;
  readonly directory: string;
  readonly subjectDigest: string;
  readonly binary?: string;
  readonly projectRoot?: string;
  readonly blockedPaths?: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<BrowserJourneyResult> {
  const journey = browserJourneySchema.parse(options.journey);
  if (options.signal?.aborted)
    return {
      status: "cancelled",
      captures: [],
      operations: [],
      failure: { kind: "environment", message: "Browser journey cancelled before startup" },
    };
  const localFile = new URL(journey.url).protocol === "file:";
  if (localFile) {
    if (!options.projectRoot)
      throw new Error("Local-file journeys require an explicit project root");
    await readBrowserFile(options.projectRoot, journey.url, options.blockedPaths);
  }
  const session = await openBrowserSession({
    ...options,
    viewport: journey.viewport,
    fileRoot: localFile ? options.projectRoot : undefined,
  });
  const captures: ProductReviewCapture[] = [];
  const deadline = Date.now() + 60_000;
  const progress: { actionIndex?: number } = {};
  const cancel = () => {
    void session.close().catch(() => {});
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await bounded("Browser journey", 60_000, async (signal) => {
      const capture = async () => {
        signal.throwIfAborted();
        if (captures.length === 6) throw new Error("Journey exceeds six representative captures");
        captures.push(await session.capture());
      };
      await executeJourney(
        session,
        journey,
        capture,
        progress,
        options.signal ? AbortSignal.any([signal, options.signal]) : signal,
      );
      return { status: "completed" as const, captures, operations: session.operations };
    });
  } catch (cause) {
    return await failedJourney(
      session,
      captures,
      cause,
      deadline,
      progress.actionIndex,
      options.signal,
    );
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    await session.close();
  }
}

async function executeJourney(
  session: BrowserSession,
  journey: BrowserJourney,
  capture: () => Promise<void>,
  progress: { actionIndex?: number },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await session.navigate(journey.url);
  await capture();
  session.assertHealthy?.();
  for (const [index, action] of journey.actions.entries()) {
    progress.actionIndex = index;
    signal.throwIfAborted();
    await performAction(session, action, capture, signal);
    session.assertHealthy?.();
    if (action.capture) await capture();
  }
  if (journey.actions.length && !journey.actions.at(-1)?.capture) await capture();
  session.assertHealthy?.();
}

async function failedJourney(
  session: BrowserSession,
  captures: ProductReviewCapture[],
  cause: unknown,
  deadline: number,
  actionIndex?: number,
  signal?: AbortSignal,
): Promise<BrowserJourneyResult> {
  if (cause instanceof BrowserSecurityError) throw cause;
  if (cause instanceof BrowserBehaviorFailure) {
    const operationId = cause.operationId ?? session.operations.at(-1)?.id;
    const diagnosticGaps = await captureFailureImage(session, captures, deadline);
    return {
      status: cause.status,
      captures,
      operations: session.operations,
      failure: {
        kind: "behavior",
        message: cause.message,
        actionIndex,
        operationId,
        diagnosticGaps,
      },
    };
  }
  if (
    signal?.aborted ||
    (cause instanceof Error && cause.message === "Browser journey: timed out after 60000ms")
  ) {
    await session.close();
    return {
      status: signal?.aborted ? "cancelled" : "timed-out",
      captures,
      operations: session.operations,
      failure: {
        kind: "environment",
        message: signal?.aborted
          ? "Browser journey cancelled"
          : "Browser journey exceeded 60 seconds",
        actionIndex,
      },
    };
  }
  if (cause instanceof BrowserRuntimeError)
    return {
      status: cause.status,
      captures,
      operations: session.operations,
      failure: { kind: "environment", message: cause.message, actionIndex },
    };
  throw cause;
}

async function captureFailureImage(
  session: BrowserSession,
  captures: ProductReviewCapture[],
  deadline: number,
): Promise<string[]> {
  try {
    if (captures.length < 6)
      captures.push(
        await bounded("Failure capture", Math.max(1, Math.min(10_000, deadline - Date.now())), () =>
          session.capture(),
        ),
      );
    return [];
  } catch (cause) {
    if (cause instanceof BrowserSecurityError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return [`Failure screenshot unavailable: ${message.slice(0, 2048)}`];
  }
}

async function performAction(
  session: BrowserSession,
  action: BrowserJourney["actions"][number],
  capture: () => Promise<void>,
  journeySignal: AbortSignal,
): Promise<void> {
  if (action.kind === "click" || action.kind === "tap" || action.kind === "move")
    await actAtPoint(session, action);
  else if (action.kind === "compare") await compareBrowserValues(session, action);
  else if (action.kind === "key") await session.page.keyboard.press(action.key);
  else if (action.kind === "drag") await performDrag(session, action, capture);
  else if (action.kind === "wait-for") await waitForObservation(session, action, journeySignal);
  else if (action.kind === "scroll") await scrollToElement(session, action, journeySignal);
  else if (action.kind === "resize") await session.resize(action.viewport);
  // Elapsed time is not an observation or a passing assertion; the next action must check state.
  else if (action.kind === "wait")
    await delay(action.durationMs, undefined, { signal: journeySignal });
}

async function performDrag(
  session: BrowserSession,
  action: Extract<BrowserJourney["actions"][number], { kind: "drag" }>,
  capture: () => Promise<void>,
): Promise<void> {
  const control = await session.page.evaluate(
    measureControl,
    action.from ? { selector: action.selector, point: action.from } : action.selector,
  );
  if (!control.reachable)
    throw new BrowserBehaviorFailure(`${action.selector}: ${control.reasons.join("; ")}`);
  const from = action.from ?? { x: control.x, y: control.y };
  const geometry = await session.page.evaluate(
    ({ selector, from, to }) => {
      const element = document.querySelector(selector);
      const box = element?.getBoundingClientRect();
      const hit = document.elementFromPoint(from.x, from.y);
      return {
        origin:
          !!box &&
          from.x >= box.left &&
          from.x < box.right &&
          from.y >= box.top &&
          from.y < box.bottom &&
          !!hit &&
          !!element?.contains(hit),
        destination: to.x >= 0 && to.x < innerWidth && to.y >= 0 && to.y < innerHeight,
      };
    },
    { selector: action.selector, from, to: action.to },
  );
  if (!geometry.origin || !geometry.destination)
    throw new BrowserBehaviorFailure("Drag must start on the control and end within the viewport");
  await session.drag(
    {
      from,
      to: action.to,
      input: action.input ?? DRAG_DEFAULTS.input,
      cancel: action.cancel ?? DRAG_DEFAULTS.cancel,
      steps: action.steps ?? DRAG_DEFAULTS.steps,
      durationMs: action.durationMs ?? DRAG_DEFAULTS.durationMs,
    },
    action.captureDuring ? capture : undefined,
  );
}
