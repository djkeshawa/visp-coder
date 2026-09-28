import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { compactTrail, pruneProductTrail } from "../../../../src/workflow/product/trail.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let project: TestWorkspace;
afterEach(async () => project?.destroy());
it("bounds unreferenced executions and runs while retaining referenced evidence", async () => {
  ({ workspace: project } = await productWorkspace());
  const record = await readProductRecord(await project.state());
  if (!record.ok) throw new Error(record.error.message);
  const executions = Array.from({ length: 150 }, (_, index) => ({
    id: `EX-${index}`,
    check: "C001",
    subjectDigest: "subject",
    contractDigest: "contract",
    createdAt: new Date().toISOString(),
    command: "node --test",
    provenance: "supervisor-executed" as const,
    assertions: "agent-reported" as const,
    status: "passed" as const,
    exitCode: 0,
    durationMs: 1,
    output: "passed",
  }));
  const compact = compactTrail({
    ...record.value.state,
    executions,
    captureRuns: Array.from({ length: 50 }, (_, index) => ({ id: `CAPRUN-${index}` })),
    controls: [{ execution: "EX-0", run: "CAPRUN-0" }],
  });
  expect(compact.executions).toHaveLength(101);
  expect(compact.captureRuns).toHaveLength(21);
  expect(compact.executions[0]?.id).toBe("EX-0");
});

it("prunes orphan artifacts and preserves candidates referenced by critic history", async () => {
  const setup = await productWorkspace();
  project = setup.workspace;
  const base = `.visp/features/${setup.brief.feature}`;
  await project.write(`${base}/candidates/CAN-live.json`, "live");
  await project.write(`${base}/candidates/CAN-orphan.json`, "orphan");
  await project.write(`${base}/captures/orphan.png`, "orphan");
  await project.write(
    `${base}/critic/selection.json`,
    JSON.stringify({ attempts: [{ candidate: "CAN-live" }] }),
  );
  const result = await pruneProductTrail(await project.state());
  expect(result).toMatchObject({ ok: true, value: { removed: 2 } });
  expect(await readFile(join(project.root, base, "candidates/CAN-live.json"), "utf8")).toBe("live");
  expect(project.git("check-ignore", `${base}/captures/orphan.png`).trim()).toContain(
    "captures/orphan.png",
  );
});
