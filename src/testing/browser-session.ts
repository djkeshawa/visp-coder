/// <reference lib="dom" />
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../core/hash.js";
import { redactText } from "../core/redaction.js";
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
import { PROJECT_SCHEME } from "./project-server.js";

const CHROME_ERROR_PAGE = "chrome-error://chromewebdata/";

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
/** `annotate` adds a fact about the main document VISP itself served to the navigate operation. */
export interface NavigateOptions {
  readonly annotate?: (finalUrl: string) => string | undefined;
}
export interface BrowserSession {
  readonly page: InteractionPage;
  readonly operations: readonly BrowserOperation[];
  /** Poll without retaining a growing log. Record the terminal observation separately. */
  assertHealthy?(): void;
  sample<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  record(kind: "observe" | "scroll", description: string, result: unknown): string;
  navigate(url: string, options?: NavigateOptions): Promise<void>;
  /** Change the viewport in place; preserves the current document and application state. */
  resize(viewport: { width: number; height: number }): Promise<void>;
  drag(gesture: DragGesture, intermediate?: () => Promise<void>): Promise<void>;
  /** `allowErrorPage` is only for a failure image: Chrome's own error page is not product evidence. */
  capture(options?: { allowErrorPage?: boolean }): Promise<ProductReviewCapture>;
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
  /**
   * How operations and capture routes name a URL VISP itself serves (`project:/index.html`, never
   * the ephemeral port), so the same journey on another run has the same route. Navigation and
   * confinement always use the real URL.
   */
  readonly present?: (url: string) => string;
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
      // close() is flagged before it unsubscribes; a late event must not throw from record().
      if (
        closed ||
        event.sessionId !== send.sessionId ||
        event.method !== "Runtime.exceptionThrown"
      )
        return;
      const message = redactText(applicationException(event.params), { root: options.fileRoot });
      if (errors.length < 5) {
        errors.push(message);
        record("observe", "Uncaught application exception", message);
      }
    });
    // Main-document responses by loader; a navigation reads its own entry after load.
    const documents = new Map<string, { status: number; url: string }>();
    const unsubscribeDocuments = transport.onEvent((event) => {
      if (event.sessionId !== send.sessionId || event.method !== "Network.responseReceived") return;
      const response = event.params.response as { status?: unknown; url?: unknown } | undefined;
      if (event.params.type !== "Document" || typeof response?.status !== "number") return;
      if (typeof event.params.loaderId !== "string") return;
      documents.set(event.params.loaderId, {
        status: response.status,
        url: String(response.url),
      });
    });
    const assertHealthy = () => {
      if (errors.length) throw new BrowserBehaviorFailure(errors.join("\n"));
    };
    await send("Runtime.enable");
    await send("Network.enable");
    const pointer = { x: 0, y: 0 };
    const page = interactionPage(inputSend, record, pointer);
    const quietPage = interactionPage(inputSend, () => {});
    const present = options.present ?? ((value: string) => value);
    const navigate = async (url: string, navigation?: NavigateOptions) => {
      await checkNavigation(url, options.fileRoot, options.blockedPaths);
      documents.clear();
      const response = await inputSend("Page.navigate", { url });
      const served =
        typeof response.loaderId === "string" ? documents.get(response.loaderId) : undefined;
      if (response.errorText && !(served && served.status >= 400))
        throw new Error(String(response.errorText));
      await inputSend("Runtime.evaluate", {
        expression:
          "new Promise(resolve => { if (document.readyState === 'complete') resolve(); else addEventListener('load', () => resolve(), {once:true}); })",
        awaitPromise: true,
      });
      await files?.check();
      const note = servedDocumentNote(url, served, present);
      const fact = served && served.status < 400 ? navigation?.annotate?.(served.url) : undefined;
      record("navigate", `Navigate ${present(url)}${note.suffix}${fact ? `, ${fact}` : ""}`);
      if (note.failure) throw new BrowserBehaviorFailure(note.failure);
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
      async capture(captureOptions) {
        const route = await page.evaluate(() => location.href, undefined);
        // Chrome's own error page (an empty 4xx/5xx answer) is a valid failure image, never evidence.
        if (!(captureOptions?.allowErrorPage && route === CHROME_ERROR_PAGE))
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
        record("capture", `Capture ${present(route)}`, bytes.toString("base64"), id);
        return {
          id,
          path,
          sha256: sha256(bytes),
          subjectDigest: options.subjectDigest,
          route: present(route),
          steps: operations
            .filter((operation) => operation.kind !== "measure" && operation.kind !== "capture")
            .slice(-4)
            .map((operation) => operation.description),
          operationIndex: operations.length - 1,
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
          unsubscribeDocuments();
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

/** What the server answered for the main document; file: documents are fulfilled locally, not served. */
function servedDocumentNote(
  url: string,
  served: { status: number; url: string } | undefined,
  present: (url: string) => string,
): { suffix: string; failure?: string } {
  const requested = new URL(url);
  if (!served || requested.protocol === "file:") return { suffix: "" };
  requested.hash = "";
  const redirect = served.url === requested.href ? "" : `, redirected to ${present(served.url)}`;
  const suffix = ` (HTTP ${served.status}${redirect})`;
  if (served.status < 400) return { suffix };
  const display = present(url);
  if (display.startsWith(PROJECT_SCHEME))
    return {
      suffix,
      failure:
        served.status === 404
          ? `${display} does not exist in the project (HTTP 404); check the path relative to the project root.`
          : `${display} could not be served from the project (HTTP ${served.status}). .env files, .git, .visp, dist/, build/ and node_modules/ are never served; an app that needs them must run its own server on a free port and use its http://127.0.0.1:<port>/ URL as the journey url.`,
    };
  return {
    suffix,
    failure: `${url} answered HTTP ${served.status}. Either the server is serving a different directory or app than this project, or the page does not exist. Serve this project's files (for a static page use "project:/<file>" as the journey url) and confirm the URL returns 200 before rerunning.`,
  };
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
      if (result.exceptionDetails) {
        const details = result.exceptionDetails as {
          text?: string;
          exception?: { description?: string };
        };
        const description =
          details.exception?.description ?? details.text ?? "Browser evaluation failed";
        if (
          /SyntaxError|DOMException/.test(description) &&
          /querySelector|\.matches|\.closest|valid selector/i.test(description)
        )
          throw new BrowserBehaviorFailure(`Invalid CSS selector: ${description.slice(0, 512)}`);
        throw new Error(JSON.stringify(result.exceptionDetails));
      }
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
