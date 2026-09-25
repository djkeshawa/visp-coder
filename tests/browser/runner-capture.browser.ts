import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { probeBrowserCapability } from "../../src/testing/browser-capability.js";
import { runBrowserJourney } from "../../src/testing/browser-journey.js";
import { productJourneyGaps } from "../../src/workflow/evidence/product-journey.js";

/** Exercises the production adapter, including its default browser sandbox. */
describe("runner-owned browser capture", () => {
  it("probes a real isolated blank browser without project navigation", async () => {
    await expect(probeBrowserCapability()).resolves.toBeUndefined();
  });
  it("drives a real journey and captures distinct rendered states with automatic receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visp-capture-browser-test-"));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><button style=\"margin:40px;padding:30px\" onclick=\"this.textContent='Launched';document.body.style.background='lightblue'\">Launch</button>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server port");
      const navigationOnly = await runBrowserJourney({
        directory,
        subjectDigest: "a".repeat(64),
        journey: { url: `http://127.0.0.1:${address.port}/`, actions: [] },
      });
      expect(navigationOnly.captures).toHaveLength(1);
      expect(
        productJourneyGaps({
          subjectDigest: "a".repeat(64),
          images: navigationOnly.captures,
          linkedEvidence: navigationOnly.captures.map((capture) => capture.id),
          captureRuns: [
            {
              version: 1,
              provenance: "runner-executed",
              subjectDigest: "a".repeat(64),
              ...navigationOnly,
            },
          ],
        }),
      ).toHaveLength(1);
      const result = await runBrowserJourney({
        directory,
        subjectDigest: "a".repeat(64),
        journey: {
          url: `http://127.0.0.1:${address.port}/`,
          actions: [{ kind: "click", selector: "button", capture: true }],
        },
      });
      expect(result.captures).toHaveLength(2);
      expect(result.captures[0]?.sha256).not.toBe(result.captures[1]?.sha256);
      for (const capture of result.captures) {
        expect(capture.provenance).toBe("runner-captured");
        expect(sha256(await readFile(capture.path))).toBe(capture.sha256);
      }
      expect(result.operations.filter((entry) => entry.kind === "pointer")).toHaveLength(2);
      expect(
        result.operations.some(
          (entry) => entry.kind === "measure" && entry.measurement?.json.includes("reachable"),
        ),
      ).toBe(true);
      expect(
        productJourneyGaps({
          subjectDigest: "a".repeat(64),
          images: result.captures,
          linkedEvidence: result.captures.map((capture) => capture.id),
          captureRuns: [
            { version: 1, provenance: "runner-executed", subjectDigest: "a".repeat(64), ...result },
          ],
        }),
      ).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});
