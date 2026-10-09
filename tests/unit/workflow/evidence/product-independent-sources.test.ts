import { afterEach, beforeEach, expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import { independentSources } from "../../../../src/workflow/product/independent-sources.js";
import type { ProductSource } from "../../../../src/workflow/product/sources.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
beforeEach(async () => {
  workspace = await TestWorkspace.create();
});
afterEach(async () => {
  await workspace.destroy();
});

const FILE = "src/value.mjs";
const CONTENT = "export const value = 1;\nexport const other = 2;\n";

function source(overrides: Partial<ProductSource> = {}): ProductSource {
  return {
    id: "S001",
    kind: "implementation-file",
    reference: FILE,
    sha256: sha256(CONTENT),
    available: true,
    excerpt: CONTENT,
    ...overrides,
  };
}

it("refuses a source whose bytes changed after it was observed", async () => {
  await workspace.write(FILE, "export const value = 3;\n");
  const delivered = await independentSources(await workspace.state(), [source()]);
  expect(delivered).toMatchObject({
    ok: false,
    error: { code: "EVIDENCE_FAILED", message: `Source changed while preparing review: ${FILE}` },
  });
});

it("refuses a pinned file deleted after it was observed", async () => {
  const delivered = await independentSources(await workspace.state(), [
    source({ kind: "pinned-file" }),
  ]);
  expect(delivered).toMatchObject({
    ok: false,
    error: { message: `Source changed while preparing review: ${FILE}` },
  });
});

it("discloses the cutoff of a bounded excerpt that carried no omission note", async () => {
  await workspace.write(FILE, CONTENT);
  const delivered = await independentSources(await workspace.state(), [
    source({ excerpt: "export const value = 1;\n" }),
  ]);
  if (!delivered.ok) throw new Error(delivered.error.message);
  expect(delivered.value[0]).toMatchObject({
    truncated: true,
    omittedRegions: [expect.stringContaining("outside the bounded excerpt was omitted")],
  });
});

it("delivers whole files and points at the design once when reviewing understanding", async () => {
  await workspace.write(FILE, CONTENT);
  const delivered = await independentSources(
    await workspace.state(),
    [
      source({ excerpt: "export const value = 1;\n", truncated: true }),
      source({ id: "S002", kind: "authored-brief", reference: ".visp/brief.yaml" }),
      source({ id: "S003", reference: "src/missing.mjs", available: false }),
    ],
    true,
  );
  if (!delivered.ok) throw new Error(delivered.error.message);
  expect(delivered.value.map((entry) => entry.id)).toEqual(["S001", "S002"]);
  expect(delivered.value[0]).toMatchObject({ excerpt: CONTENT, truncated: false });
  expect(delivered.value[1]?.excerpt).toBe("The proposed design is supplied once in design.brief.");
});
