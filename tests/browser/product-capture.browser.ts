import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import type { Result } from "../../src/core/result.js";
import { productReply } from "../../src/mcp/tools/workflow.js";
import { runProductCapture } from "../../src/workflow/evidence/product-capture.js";
import { runProductReview } from "../../src/workflow/product/review.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { productWorkspace } from "../unit/support/product-workspace.js";

describe("public product capture service", () => {
  it("publishes every real browser image and delivers them after browser cleanup", async () => {
    const { workspace, brief } = await productWorkspace();
    let html = `<!doctype html><button style="margin:40px;padding:30px" onclick="this.textContent=Number(this.textContent)+1;document.body.style.background=this.textContent==='1'?'lightblue':'coral'">0</button>`;
    await workspace.write("index.html", html);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server port");
      const state = await workspace.state();
      const captured = await runProductCapture(state, {
        feature: brief.feature,
        task: "T001",
        journey: {
          url: `http://127.0.0.1:${address.port}/`,
          actions: [
            { kind: "click", selector: "button", capture: true },
            { kind: "click", selector: "button", capture: true },
          ],
        },
      });
      if (!captured.ok) throw new Error(captured.error.message);
      expect(captured.value.captures).toHaveLength(3);
      expect(captured.value.images).toHaveLength(3);
      const delivered = productReply("visp_capture", captured).content.filter(
        (block) => block.type === "image",
      );
      expect(delivered).toHaveLength(3);
      expect(delivered.map((block) => sha256(Buffer.from(block.data, "base64")))).toEqual(
        captured.value.captures.map((capture) => capture.sha256),
      );
      for (const image of captured.value.images ?? [])
        expect(sha256(Buffer.from(image.data, "base64"))).toBe(image.sha256);
      expect(new Set(captured.value.captures.map((capture) => capture.sha256)).size).toBe(3);
      for (const capture of captured.value.captures)
        expect(sha256(await readFile(join(workspace.root, capture.path)))).toBe(capture.sha256);
      const record = await readProductRecord(state, { feature: brief.feature });
      if (!record.ok) throw new Error(record.error.message);
      expect(record.value.state.captureRuns).toHaveLength(1);
      expect(record.value.state.captures).toHaveLength(3);
      const review = await runProductReview(state, { feature: brief.feature, task: "T001" });
      if (!review.ok) throw new Error(review.error.message);
      expect(review.value.images).toHaveLength(3);
      expect(review.value.gaps).toEqual([]);
      expect(record.value.state.reviews).toEqual([]);
      // Same real pointer path, but a broken handler cannot produce the expected result.
      const expected = await runProductCapture(state, {
        feature: brief.feature,
        task: "T001",
        journey: {
          url: `http://127.0.0.1:${address.port}/`,
          actions: [
            { kind: "click", selector: "button" },
            { kind: "wait-for", selector: "button", text: "1", timeoutMs: 500, capture: true },
          ],
        },
      });
      const expectedRun = unwrap(expected);
      expect(expectedRun.status).toBe("completed");
      html = html.replace("this.textContent=Number(this.textContent)+1", "this.textContent=0");
      await workspace.write("index.html", html);
      const replayed = await runProductCapture(state, {
        feature: brief.feature,
        task: "T001",
        replay: expectedRun.runId,
      });
      const replayedRun = unwrap(replayed);
      expect(replayedRun.behaviorChange).toMatchObject({
        change: "possible-regression",
        before: { runId: expectedRun.runId, status: "completed" },
      });
      expect(replayedRun.status).not.toBe("completed");
      const history = await readProductRecord(state, { feature: brief.feature });
      const finalRecord = unwrap(history);
      expect(finalRecord.state.captureRuns).toHaveLength(3);
      expect(finalRecord.state.reviews).toEqual([]);
      html = html.replace("this.textContent=0", "this.textContent=Number(this.textContent)+1");
      await workspace.write("index.html", html);
      const recovered = unwrap(
        await runProductCapture(state, {
          feature: brief.feature,
          task: "T001",
          replay: expectedRun.runId,
        }),
      );
      expect(recovered).toMatchObject({
        status: "completed",
        behaviorChange: { change: "recovered-execution", before: { runId: replayedRun.runId } },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await workspace.destroy();
    }
  });
});

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
