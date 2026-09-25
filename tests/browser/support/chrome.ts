import { interactionPage, pageConnection } from "../../../src/testing/browser-session.js";
import { launchChrome } from "../../../src/testing/chrome-transport.js";

/** Tests use the same bounded, sandboxed isolated browser as product capture. */
export async function openChrome() {
  const transport = await launchChrome();
  try {
    const send = await pageConnection(transport);
    const page = interactionPage(send, () => {});
    async function setContent(html: string, width: number, height: number) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const tree = await send("Page.getFrameTree");
      const frameId = (tree.frameTree as { frame: { id: string } }).frame.id;
      await send("Page.setDocumentContent", { frameId, html });
    }
    return { page, setContent, close: transport.close, send };
  } catch (cause) {
    await transport.close();
    throw cause;
  }
}
