import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { createServer } from "../../../../src/mcp/server.js";
import { observationBundle } from "../../../../src/workflow/evidence/observation-delivery.js";
import { recordObservation } from "../../../../src/workflow/evidence/observations.js";
import { readObservations } from "../../../../src/workflow/evidence/observations-reader.js";
import { runProductMigrate } from "../../../../src/workflow/product/migration.js";
import { runJson } from "../../cli/support/cli.js";
import { pngHeader, TestWorkspace, task } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => workspace?.destroy());
it("delivers scoped image bytes with uncertainty and refuses stale evidence for required review", async () => {
  workspace = await TestWorkspace.create({
    "src/app.ts": "export const ready = true;",
    "screen.png": pngHeader(100, 100),
  });
  const feature = "001-images";
  await workspace.withFeature(feature, [task({ requirements: ["REQ001"] })]);
  await workspace.withSpec(feature, [
    {
      id: "REQ001",
      statement: "Ready",
      priority: "must",
      criteria: [{ id: "AC001", statement: "Ready is visible" }],
    },
  ]);
  await workspace.ensureContext(feature);
  const state = await workspace.state();
  const recorded = await recordObservation(state, {
    feature,
    task: "T001",
    criterion: "AC001",
    source: "browser",
    result: "unclear",
    note: "Captured, not yet inspected",
    viewport: { width: 100, height: 100 },
    route: "/",
    steps: ["Open ready screen"],
    artifacts: ["screen.png"],
  });
  if (!recorded.ok) throw new Error(recorded.error.message);
  const bundle = await observationBundle(state, feature, "AC001");
  if (!bundle.ok) throw new Error(bundle.error.message);
  expect(bundle.value.images).toHaveLength(1);
  expect(Buffer.from(bundle.value.images[0]?.data ?? "", "base64")).toEqual(pngHeader(100, 100));
  expect(bundle.value.observations[0]?.result).toBe("unclear");
  const other = await observationBundle(state, feature, "AC002");
  expect(other.ok && other.value.images).toEqual([]);
  const historyBefore = await state.store.readObservations(feature, "T001");
  const migrated = await runProductMigrate(await workspace.state(), { feature });
  expect(migrated, JSON.stringify(migrated)).toMatchObject({ ok: true });
  const current = await workspace.state();
  expect(
    await readObservations(current, { feature, criterion: "AC001", outcome: "REQ001" }),
  ).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
  expect(
    await readObservations(current, { feature, criterion: "AC001", task: "T999" }),
  ).toMatchObject({ ok: false, error: { code: "TASK_NOT_FOUND" } });
  expect(
    await readObservations(current, { feature: "../outside", criterion: "AC001" }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  expect(
    await readObservations(current, { feature, criterion: "AC001", task: "../T001" }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  const cli = await runJson(
    workspace.root,
    "observations",
    "--criterion",
    "AC001",
    "--task",
    "T001",
  );
  expect(cli.envelope).toMatchObject({
    ok: true,
    data: { observations: [{ criterion: "AC001" }] },
  });
  expect(await current.store.readObservations(feature, "T001")).toEqual(historyBefore);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(workspace.root, "standard");
  const client = new Client({ name: "observation-test", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "visp_observations",
      arguments: { criterion: "AC001" },
    });
    expect(response.content).toContainEqual(
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        data: bundle.value.images[0]?.data,
      }),
    );
    expect(response.structuredContent).toMatchObject({
      ok: true,
      data: { observations: [{ result: "unclear" }] },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
