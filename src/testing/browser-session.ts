/// <reference lib="dom" />
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../core/hash.js";
import { imageDimensions } from "../workflow/evidence/observations/media.js";
import type { ProductReviewCapture } from "../workflow/evidence/product-review.js";
import type { InteractionPage } from "./browser.js";
import { applicationException } from "./browser-errors.js";
import { BrowserSecurityError, confineBrowserFiles, readBrowserFile } from "./browser-files.js";
import { type DragGesture, dispatchDrag, dispatchPointerTravel } from "./browser-gestures.js";
import { browserKey } from "./browser-keys.js";
import { measureRenderedLayout } from "./browser-layout.js";
import { BrowserBehaviorFailure } from "./browser-observations.js";
import { type ChromeTransport, launchChrome } from "./chrome-transport.js";

export interface BrowserOperation {
  readonly id: string;
  readonly kind:
    | "navigate"
    | "measure"
    | "observe"
    | "scroll"
    | "pointer"
    | "touch"
    | "keyboard"
    | "capture";
  readonly description: string;
  readonly completedAt: string;
  readonly resultDigest?: string;
  readonly captureId?: string;
  /** Bounded serialized observed value; truncation is explicit and never a passing assertion. */
  readonly measurement?: { readonly json: string; readonly truncated: boolean };
}
export interface BrowserSession {
  readonly page: InteractionPage;
  readonly operations: readonly BrowserOperation[];
  /** Poll without retaining a growing log. Record the terminal observation separately. */
  assertHealthy?(): void;
  sample<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  record(kind: "observe" | "scroll", description: string, result: unknown): string;
  navigate(url: string): Promise<void>;
  /** Change the viewport in place; preserves the current document and application state. */
  resize(viewport: { width: number; height: number }): Promise<void>;
  drag(gesture: DragGesture, intermediate?: () => Promise<void>): Promise<void>;
  capture(): Promise<ProductReviewCapture>;
  close(): Promise<void>;
}

/** Owns process, operation count, capture bytes and IDs; callers author actions and expectations. */
export async function openBrowserSession(options: {
  readonly subjectDigest: string;
  readonly directory: string;
  readonly binary?: string;
  readonly startupTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly viewport?: { width: number; height: number };
  readonly fileRoot?: string;
  readonly blockedPaths?: readonly string[];
}): Promise<BrowserSession> {
  if (!/^[0-9a-f]{64}$/.test(options.subjectDigest))
    throw new Error("subjectDigest must be SHA-256");
  let viewport = checkedViewport(options.viewport ?? { width: 1280, height: 720 });
  const transport = await launchChrome(options);
  try {
    const send = await pageConnection(transport);
    const files = options.fileRoot
      ? await confineBrowserFiles(transport, send, options.fileRoot, options.blockedPaths)
      : undefined;
    await send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const operations: BrowserOperation[] = [];
    const writes = new Set<Promise<void>>();
    let closed = false;
    let closing: Promise<void> | undefined;
    const assertOpen = () => {
      if (closed) throw new Error("Browser session is closed");
    };
    let remainingMeasurements = 24_000;
    const record = (
      kind: BrowserOperation["kind"],
      description: string,
      result?: unknown,
      captureId?: string,
    ) => {
      assertOpen();
      const serialized = result === undefined ? undefined : JSON.stringify(result);
      const measurement = boundedMeasurement(kind, serialized, remainingMeasurements);
      if (kind === "measure") remainingMeasurements -= measurement?.json.length ?? 0;
      const id = randomUUID();
      operations.push({
        id,
        kind,
        description,
        completedAt: new Date().toISOString(),
        ...(serialized === undefined ? {} : { resultDigest: sha256(serialized) }),
        ...(captureId === undefined ? {} : { captureId }),
        ...(measurement ? { measurement } : {}),
      });
      return id;
    };
    const inputSend: PageSend = async (method, params) => {
      assertOpen();
      try {
        return await send(method, params);
      } catch (cause) {
        await files?.check();
        throw cause;
      }
    };
    const errors: string[] = [];
    const unsubscribeErrors = transport.onEvent((event) => {
      if (event.sessionId !== send.sessionId || event.method !== "Runtime.exceptionThrown") return;
      const message = applicationException(event.params);
      if (errors.length < 5) {
        errors.push(message);
        record("observe", "Uncaught application exception", message);
      }
    });
    const assertHealthy = () => {
      if (errors.length) throw new BrowserBehaviorFailure(errors.join("\n"));
    };
    await send("Runtime.enable");
    const pointer = { x: 0, y: 0 };
    const page = interactionPage(inputSend, record, pointer);
    const quietPage = interactionPage(inputSend, () => {});
    const navigate = async (url: string) => {
      await checkNavigation(url, options.fileRoot, options.blockedPaths);
      const response = await inputSend("Page.navigate", { url });
      if (response.errorText) throw new Error(String(response.errorText));
      await inputSend("Runtime.evaluate", {
        expression:
          "new Promise(resolve => { if (document.readyState === 'complete') resolve(); else addEventListener('load', () => resolve(), {once:true}); })",
        awaitPromise: true,
      });
      await files?.check();
      record("navigate", `Navigate ${url}`);
    };
    return {
      page,
      assertHealthy,
      sample: async (fn, arg) => {
        assertHealthy();
        const result = await quietPage.evaluate(fn, arg);
        assertHealthy();
        return result;
      },
      record,
      navigate,
      async resize(requested) {
        const next = checkedViewport(requested);
        const before = { ...viewport };
        await inputSend("Emulation.setDeviceMetricsOverride", {
          ...next,
          deviceScaleFactor: 1,
          mobile: false,
        });
        assertOpen();
        viewport = next;
        // Wait for resize handlers and a rendered frame; delayed application work can
        // be observed with an explicit wait-for action, just as after other input.
        const observed = await quietPage.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight })),
              ),
            ),
          undefined,
        );
        await files?.check();
        assertHealthy();
        record(
          "observe",
          `Resize viewport from ${before.width}×${before.height} to ${next.width}×${next.height}`,
          {
            before,
            requested: next,
            observed,
          },
        );
      },
      drag: async (gesture, intermediate) => {
        if (gesture.input === "pointer") await page.mouse.move?.(gesture.from.x, gesture.from.y);
        await dispatchDrag(inputSend, record, gesture, intermediate);
        if (gesture.input === "pointer") Object.assign(pointer, gesture.to);
      },
      get operations() {
        return structuredClone(operations);
      },
      async capture() {
        const route = await page.evaluate(() => location.href, undefined);
        await checkNavigation(route, options.fileRoot, options.blockedPaths);
        await files?.check();
        const id = `CAP-${randomUUID()}`;
        const layout = await quietPage.evaluate(measureRenderedLayout, undefined);
        record(
          "measure",
          "Measure rendered layout",
          { kind: "rendered-layout", captureId: id, result: layout },
          id,
        );
        const bytes = await captureScreenshot(inputSend);
        assertOpen();
        await mkdir(options.directory, { recursive: true });
        assertOpen();
        const path = join(options.directory, `${id}.png`);
        const writing = writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        writes.add(writing);
        try {
          await writing;
        } finally {
          writes.delete(writing);
        }
        assertOpen();
        await files?.check();
        record("capture", `Capture ${route}`, bytes.toString("base64"), id);
        return {
          id,
          path,
          sha256: sha256(bytes),
          subjectDigest: options.subjectDigest,
          route,
          steps: operations
            .filter((operation) => operation.kind !== "measure" && operation.kind !== "capture")
            .map((operation) => operation.description),
          viewport: { ...viewport },
          createdAt: new Date().toISOString(),
          provenance: "runner-captured",
        };
      },
      close() {
        if (closing) return closing;
        closed = true;
        closing = (async () => {
          await Promise.allSettled([...writes]);
          unsubscribeErrors();
          files?.dispose();
          await transport.close();
        })();
        return closing;
      },
    };
  } catch (cause) {
    await transport.close();
    throw cause;
  }
}

function checkedViewport(viewport: { width: number; height: number }) {
  if (
    ![viewport.width, viewport.height].every(
      (size) => Number.isInteger(size) && size > 0 && size <= 16384,
    )
  )
    throw new Error("Viewport dimensions must be integers from 1 to 16384");
  return { width: viewport.width, height: viewport.height };
}

function boundedMeasurement(
  kind: BrowserOperation["kind"],
  serialized: string | undefined,
  remaining: number,
): BrowserOperation["measurement"] {
  if (!["measure", "observe", "scroll", "pointer"].includes(kind) || serialized === undefined)
    return undefined;
  const limit = kind === "measure" ? Math.min(4_000, remaining) : 12_000;
  const json = serialized.slice(0, limit);
  return { json, truncated: json.length !== serialized.length };
}

export type PageSend = ((
  method: string,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown>>) & {
  readonly sessionId?: string;
  readonly targetId?: string;
};
/** Validate the bytes for both product captures and the isolated capability probe. */
export async function captureScreenshot(send: PageSend): Promise<Buffer> {
  const response = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  if (typeof response.data !== "string") throw new Error("Browser returned no screenshot");
  const bytes = Buffer.from(response.data, "base64");
  if (!imageDimensions(bytes)) throw new Error("Browser returned an invalid screenshot");
  return bytes;
}

export async function pageConnection(transport: ChromeTransport): Promise<PageSend> {
  const target = await transport.send("Target.createTarget", { url: "about:blank" });
  const attached = await transport.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  if (typeof attached.sessionId !== "string") throw new Error("Browser returned no page session");
  const sessionId = attached.sessionId;
  const send: PageSend = Object.assign(
    (method: string, params?: Record<string, unknown>) => transport.send(method, params, sessionId),
    { sessionId, targetId: String(target.targetId) },
  );
  await send("Page.enable");
  return send;
}

export function interactionPage(
  send: PageSend,
  record: (kind: BrowserOperation["kind"], description: string, result?: unknown) => void,
  pointer = { x: 0, y: 0 },
): InteractionPage {
  const move = async (x: number, y: number, options?: { steps?: number; durationMs?: number }) => {
    if (pointer.x === x && pointer.y === y) return;
    const movement = await dispatchPointerTravel(send, { from: pointer, to: { x, y }, ...options });
    Object.assign(pointer, { x, y });
    record("pointer", `Move pointer to ${x},${y}`, movement);
  };
  return {
    async evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R> {
      const result = await send("Runtime.evaluate", {
        expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      const value = (result.result as { value: R }).value;
      record("measure", "Read browser state", value);
      return value;
    },
    mouse: {
      move,
      async click(x, y) {
        await move(x, y);
        for (const type of ["mousePressed", "mouseReleased"])
          await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
        record("pointer", `Click ${x},${y}`);
      },
    },
    touchscreen: {
      async tap(x, y) {
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        record("touch", `Tap ${x},${y}`);
      },
    },
    keyboard: {
      async press(key) {
        const { text, ...event } = browserKey(key);
        for (const type of ["keyDown", "keyUp"])
          await send("Input.dispatchKeyEvent", {
            type,
            ...event,
            ...(type === "keyDown" && text ? { text } : {}),
          });
        record("keyboard", `Press ${key}`);
      },
    },
  };
}

async function checkNavigation(
  url: string,
  root?: string,
  blocked?: readonly string[],
): Promise<void> {
  if (["http:", "https:"].includes(new URL(url).protocol)) return;
  if (new URL(url).protocol === "file:" && root) {
    await readBrowserFile(root, url, blocked);
    return;
  }
  throw new BrowserSecurityError(
    "Browser journeys require HTTP(S), or a confined project file URL",
  );
}
