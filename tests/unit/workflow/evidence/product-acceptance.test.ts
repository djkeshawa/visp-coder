import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL } from "../../../../src/mcp/constants.js";
import { createServer } from "../../../../src/mcp/server.js";
import { now } from "../../../../src/workflow/artifacts/common.js";
import { productAcceptanceSchema } from "../../../../src/workflow/artifacts/product-acceptance.js";
import { runJson } from "../../cli/support/cli.js";
import { legacyStore } from "../../support/legacy-store.js";
import { TestWorkspace } from "../../support/workspace.js";

const FEATURE = "001-product";
let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create({
    "src/model.cjs": "module.exports = { recovered: false };",
    "tests/recovery.cjs":
      "const assert = require('node:assert/strict'); assert.equal(require('../src/model.cjs').recovered, true, 'a resting shot must recover');",
  });
  await workspace.withFeature(FEATURE, [{ id: "T001", status: "done" }]);
  const state = await workspace.state();
  const intent = await state.store.readIntent(FEATURE);
  if (!intent.ok) throw new Error(intent.error.message);
  await legacyStore(state).writeIntent({ ...intent.value, finalAcceptance: true });
  await legacyStore(state).writeVerification({
    kind: "verification",
    createdAt: now(),
    feature: FEATURE,
    task: "T001",
    passed: true,
    codeEvidence: "executed",
    commands: [{ command: "node tests/task.cjs", passed: true, exitCode: 0, durationMs: 1 }],
    changedFiles: ["src/model.cjs"],
    findings: [],
  });
  await legacyStore(state).writeReview({
    kind: "review",
    createdAt: now(),
    feature: FEATURE,
    task: "T001",
    passed: true,
    basis: "working-tree",
    reviewedFiles: ["src/model.cjs"],
    criteria: [],
    findings: [],
  });
  await workspace.withSpec(FEATURE, [
    {
      id: "REQ001",
      statement: "A stalled interaction recovers",
      priority: "must",
      criteria: [
        {
          id: "AC001",
          statement: "Resting returns control to the user",
          verification: "`node tests/recovery.cjs`",
          verificationKind: "command",
          verificationLayer: "unit",
          verificationEnvironment: "project",
        },
      ],
    },
  ]);
});

afterEach(async () => {
  await workspace.destroy();
});

describe("historical product acceptance readers", () => {
  it("keeps public CLI and MCP legacy mutations read-only until explicit migration", async () => {
    await workspace.installFoundation();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(workspace.root);
    const client = new Client({ name: "legacy-boundary-test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const before = await readFile(
      join(workspace.root, ".visp/features", FEATURE, "tasks.json"),
      "utf8",
    );
    try {
      for (const operation of ["done", "accept"]) {
        expect((await runJson(workspace.root, operation)).envelope).toMatchObject({
          ok: false,
          error: { code: "MIGRATION_REQUIRED" },
        });
        expect(
          (await client.callTool({ name: `visp_${operation}`, arguments: {} })).structuredContent,
        ).toMatchObject({ ok: false, error: { code: "MIGRATION_REQUIRED" } });
      }
      expect((await runJson(workspace.root, "next")).envelope).toMatchObject({
        data: { action: "understand", mayEdit: false },
      });
      expect(
        JSON.stringify(
          (await client.callTool({ name: TOOL.next, arguments: {} })).structuredContent,
        ),
      ).toContain("migrate");
      expect(
        await readFile(join(workspace.root, ".visp/features", FEATURE, "tasks.json"), "utf8"),
      ).toBe(before);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a contradictory passing receipt instead of trusting its boolean", () => {
    expect(
      productAcceptanceSchema.safeParse({
        kind: "product-acceptance",
        createdAt: now(),
        feature: FEATURE,
        subject: "a".repeat(64),
        passed: true,
        criteria: [],
        commands: [],
        findings: [],
      }).success,
    ).toBe(false);
  });
});
