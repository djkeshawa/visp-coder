import { captureScreenshot, pageConnection } from "./browser-session.js";
import { type ChromeTransport, launchChrome } from "./chrome-transport.js";

const VIEWPORT = { width: 1024, height: 768 };

/**
 * Render an SVG to a PNG in a fresh headless browser, as a viewer would see it opened in one.
 * Reviewers can open PNG files but not SVG ones, so a vector picture otherwise reaches them
 * only as markup. The SVG is shown through an `<img>` on a data-URL page: in that context it
 * runs no script and loads nothing external. Returns undefined when no browser is available
 * or the picture does not render; the caller then has nothing to deliver, not a failure.
 */
export async function rasterizeSvg(
  svg: Uint8Array,
  options: { binary?: string; timeoutMs?: number } = {},
): Promise<Buffer | undefined> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let transport: ChromeTransport | undefined;
  try {
    transport = await launchChrome({
      binary: options.binary,
      startupTimeoutMs: timeoutMs,
      operationTimeoutMs: timeoutMs,
    });
    const send = await pageConnection(transport);
    await send("Emulation.setDeviceMetricsOverride", {
      ...VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const page = `<!doctype html><html><body style="margin:0;background:#fff"><img id="picture" alt="" style="display:block;margin:12px;width:${VIEWPORT.width - 24}px;height:${VIEWPORT.height - 24}px;object-fit:contain" src="${source}"></body></html>`;
    await send("Page.navigate", {
      url: `data:text/html;base64,${Buffer.from(page).toString("base64")}`,
    });
    const loaded = await send("Runtime.evaluate", {
      expression:
        "new Promise(resolve => { const settle = () => { const image = document.getElementById('picture'); if (!image) return resolve(false); if (image.complete) return resolve(image.naturalWidth > 0); image.onload = () => resolve(true); image.onerror = () => resolve(false); }; if (document.readyState === 'complete') settle(); else addEventListener('load', settle, { once: true }); })",
      awaitPromise: true,
      returnByValue: true,
    });
    const result = loaded.result as { value?: unknown } | undefined;
    if (result?.value !== true) return undefined;
    return await captureScreenshot(send);
  } catch {
    return undefined;
  } finally {
    await transport?.close().catch(() => undefined);
  }
}
