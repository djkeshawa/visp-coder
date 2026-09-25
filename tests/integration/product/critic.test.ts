import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../src/config/critic.js";
import type { ToolEnvelope } from "../../../src/mcp/reply.js";
import { registerCriticTool } from "../../../src/mcp/tools/critic.js";
import { runProductVerify } from "../../../src/workflow/product/index.js";
import { runProductWork } from "../../../src/workflow/product/work.js";
import { runCli, runJson } from "../../unit/cli/support/cli.js";
import { legacyReview } from "../../unit/support/legacy-critic.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";
import { productWorkspace } from "../../unit/support/product-workspace.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
let setup: Awaited<ReturnType<typeof productWorkspace>>;
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
});
afterEach(async () => {
  await setup.workspace.destroy();
});
const config = {
  model: "test-critic",
  maxCalls: 2,

  timeoutMs: 5000,

  maxImageBytes: 4 * 1024 * 1024,
};

function tool(sampling = false) {
  let handler: Handler | undefined;
  const createMessage = vi.fn();
  registerCriticTool(
    {
      registerTool(_name: string, _config: unknown, callback: Handler) {
        handler = callback;
      },
      server: { getClientCapabilities: () => (sampling ? { sampling: {} } : {}), createMessage },
    } as unknown as McpServer,
    setup.workspace.root,
  );
  return {
    createMessage,
    rawCall: async (input: Record<string, unknown>) => {
      if (!handler) throw new Error("not registered");
      return handler(input);
    },
    call: async (input: Record<string, unknown> = {}) => {
      if (!handler) throw new Error("not registered");
      const response = await handler(input);
      return response.structuredContent as unknown as ToolEnvelope<Record<string, unknown>>;
    },
  };
}

it.each(["cli", "mcp"])(
  "reports a rejected returned review as failure through %s without retrying",
  async (surface) => {
    const { workspace } = setup;
    const mcp = tool();
    const preset = balancedCritic("codex");
    if (!preset) throw new Error("preset missing");
    await runProductWork(await workspace.state(), { task: "T001" });
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    await runProductVerify(await workspace.state(), { task: "T001" });
    expect((await mcp.call({ operation: "configure", task: "T001", config: preset })).ok).toBe(
      true,
    );
    const capabilities = {
      harness: "codex",
      model: preset.model,
      reasoningEffort: preset.reasoningEffort,
      freshContext: true,
      images: true,
      readOnly: true,
      delegationAllowed: true,
    };
    const prepared = await mcp.call({ operation: "prepare", task: "T001", capabilities });
    expect(prepared.ok).toBe(true);
    const packet = JSON.parse(await readFile(String(prepared.data?.packetPath), "utf8"));
    const response = {
      summary: "Observed the public value.",
      findings: [],
      limitations: [],
      resolutions: [],
      assessments: [
        {
          outcome: packet.current.outcomes[0].id,
          status: "satisfied",
          summary: "The value matches.",
          evidence: ["27e7cbb6-115f-49f4-ad28-fd008eefa318"],
          expectations: [],
        },
      ],
    };
    let envelope: ToolEnvelope<Record<string, unknown>>;
    if (surface === "cli") {
      await workspace.write(".visp/critic-response.json", JSON.stringify(response));
      await workspace.write(".visp/critic-capabilities.json", JSON.stringify(capabilities));
      const args = [
        "critic",
        "--task",
        "T001",
        "--attempt",
        String(prepared.data?.attempt),
        "--capabilities",
        ".visp/critic-capabilities.json",
        "--submit",
        ".visp/critic-response.json",
      ];
      const result = await runJson<Record<string, unknown>>(workspace.root, ...args);
      expect(result.exitCode).not.toBe(0);
      envelope = result.envelope as unknown as ToolEnvelope<Record<string, unknown>>;
      // Replaying the same submission cannot spend another call.
      const replay = await runCli(workspace.root, ...args);
      expect(replay.exitCode).not.toBe(0);
    } else {
      const result = await mcp.rawCall({
        operation: "submit",
        task: "T001",
        attempt: prepared.data?.attempt,
        capabilities,
        response,
      });
      expect(result.isError).toBe(true);
      envelope = result.structuredContent as unknown as ToolEnvelope<Record<string, unknown>>;
    }
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toMatchObject({
      callsUsed: 1,
      lifecycle: { acceptedReview: false, returned: true },
    });
    expect(JSON.stringify(envelope.data)).toContain("Unknown evidence reference");
    expect((await mcp.call({ task: "T001" })).data).toMatchObject({ callsUsed: 1 });
  },
);
it("uses the shared validator for CLI/MCP status, configuration and invalid selections", async () => {
  const { workspace } = setup;
  const mcp = tool();
  const cli = await runJson(workspace.root, "critic", "--task", "T001");
  expect((await mcp.call({ task: "T001" })).data).toEqual(cli.envelope.data);
  await workspace.write(".visp/critic-config.json", JSON.stringify(config));
  expect(
    (
      await runJson(
        workspace.root,
        "critic",
        "--task",
        "T001",
        "--configure",
        ".visp/critic-config.json",
      )
    ).exitCode,
  ).toBe(0);
  expect((await mcp.call({ task: "T001", operation: "configure", config })).data).toMatchObject({
    unchanged: true,
  });
  const status = await runJson(workspace.root, "critic", "--task", "T001");
  expect((await mcp.call({ task: "T001", operation: "status" })).data).toEqual(
    status.envelope.data,
  );
  const unknown = await runJson(workspace.root, "critic", "--task", "T404");
  expect((await mcp.call({ task: "T404", operation: "status" })).error).toEqual(
    unknown.envelope.error,
  );
  const invalid = await runJson(workspace.root, "critic", "--expected-subject", "a".repeat(64));
  expect(
    (await mcp.call({ operation: "status", expectedSubject: "a".repeat(64) })).error?.code,
  ).toBe(invalid.envelope.error?.code);
  expect((await runJson(workspace.root, "critic", "--disable", "--dispatch")).exitCode).not.toBe(0);
  expect(mcp.createMessage).not.toHaveBeenCalled();
});

it("shares early design preflight and results across CLI/MCP without a sampling token ceiling", async () => {
  const { workspace } = setup;
  const mcp = tool(true);
  const preset = balancedCritic("codex");
  if (!preset) throw new Error("preset");
  expect((await mcp.call({ operation: "configure", task: "T001", config: preset })).ok).toBe(true);
  expect(
    (await mcp.call({ operation: "review", task: "T001", phase: "understanding" })).error?.message,
  ).toContain("requires maxTokens");
  expect(mcp.createMessage).not.toHaveBeenCalled();
  const capabilities = {
    harness: "codex",
    model: preset.model,
    reasoningEffort: "high",
    freshContext: true,
    readOnly: true,
    images: false,
    delegationAllowed: true,
  };
  await workspace.write(".visp/capabilities.json", JSON.stringify(capabilities));
  const cli = await runJson(
    workspace.root,
    "critic",
    "--task",
    "T001",
    "--phase",
    "understanding",
    "--preflight",
    "--capabilities",
    ".visp/capabilities.json",
  );
  expect(
    (await mcp.call({ operation: "preflight", task: "T001", phase: "understanding", capabilities }))
      .data,
  ).toEqual(cli.envelope.data);
  expect(cli.envelope.data).toMatchObject({ ready: true, callsUsed: 0, requiresImages: false });
  const prepared = await runJson<{ packetPath: string; attempt: string }>(
    workspace.root,
    "critic",
    "--task",
    "T001",
    "--phase",
    "understanding",
    "--prepare",
    "--capabilities",
    ".visp/capabilities.json",
  );
  const packet = JSON.parse(await readFile(String(prepared.envelope.data?.packetPath), "utf8"));
  const response = {
    review: {
      ...legacyReview(packet),
      feedback: {
        ...legacyReview(packet).feedback,
        dimensions: legacyReview(packet).feedback.dimensions.map((entry: object) => ({
          ...entry,
          status: "satisfied",
          reason: "The proposed design addresses the preserved request; product remains unobserved",
          evidence: ["SRC-REQUEST"],
        })),
      },
    },
    comparison: [],
  };
  expect(
    (
      await mcp.call({
        operation: "submit",
        task: "T001",
        attempt: prepared.envelope.data?.attempt,
        capabilities,
        response,
      })
    ).data,
  ).toMatchObject({ action: "worker", callsUsed: 1, callsRemaining: 2, phase: "understanding" });
  expect(
    (await runJson(workspace.root, "critic", "--task", "T001", "--json")).envelope.data,
  ).toMatchObject({ next: "review", callsUsed: 1 });
});
it("rejects unavailable sampling before spending budget and preserves normal review after disable", async () => {
  const { workspace } = setup;
  await runProductWork(await workspace.state(), { task: "T001" });
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  await runProductVerify(await workspace.state(), { task: "T001" });
  const mcp = tool();
  await mcp.call({ operation: "configure", task: "T001", config });
  expect((await mcp.call({ operation: "review", task: "T001" })).error).toMatchObject({
    code: "CONFIG_INVALID",
  });
  expect((await mcp.call({ operation: "status", task: "T001" })).data).toMatchObject({
    callsUsed: 0,
  });
  expect(mcp.createMessage).not.toHaveBeenCalled();
  const disabled = await runJson(workspace.root, "critic", "--off");
  expect(disabled.envelope.data).toMatchObject({ enabled: false, history: "preserved" });
  expect((await mcp.call({ operation: "status", task: "T001" })).data).toMatchObject({
    enabled: false,
    callsUsed: 0,
  });
});

it("shares native preflight, reservation and submission between MCP and CLI", async () => {
  const { workspace } = setup;
  const mcp = tool();
  const config = balancedCritic("codex");
  if (!config) throw new Error("preset");
  expect((await mcp.call({ operation: "set-policy", enabled: true, harness: "codex" })).ok).toBe(
    true,
  );
  await runProductWork(await workspace.state(), { task: "T001" });
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  await runProductVerify(await workspace.state(), { task: "T001" });
  await mcp.call({ operation: "configure", task: "T001", config });
  const capabilities = {
    harness: "codex",
    model: config.model,
    reasoningEffort: "high",
    freshContext: true,
    readOnly: true,
    images: true,
    delegationAllowed: true,
  };
  await workspace.write(".visp/capabilities.json", JSON.stringify(capabilities));
  const cli = await runJson(
    workspace.root,
    "critic",
    "--task",
    "T001",
    "--preflight",
    "--capabilities",
    ".visp/capabilities.json",
  );
  expect((await mcp.call({ operation: "preflight", task: "T001", capabilities })).data).toEqual(
    cli.envelope.data,
  );
  const prepared = await mcp.call({ operation: "prepare", task: "T001", capabilities });
  expect(prepared.ok).toBe(true);
  const packet = JSON.parse(await readFile(String(prepared.data?.packetPath), "utf8"));
  const response = {
    review: {
      ...legacyReview(packet),
      assessments: packet.current.outcomes.map((o: { id: string }) => ({
        outcome: o.id,
        status: "satisfied",
        summary: "Observed module execution",
        evidence: ["C001"],
        expectations: [],
      })),
      feedback: moduleFeedback(packet.current),
    },
    comparison: [],
  };
  await workspace.write(".visp/result.json", JSON.stringify(response));
  const submitted = await runJson(
    workspace.root,
    "critic",
    "--task",
    "T001",
    "--attempt",
    String(prepared.data?.attempt),
    "--capabilities",
    ".visp/capabilities.json",
    "--submit",
    ".visp/result.json",
  );
  expect(submitted.envelope.data).toMatchObject({ action: "normal-acceptance", callsUsed: 1 });
  expect((await runJson(workspace.root, "critic", "--off")).exitCode).toBe(0);
  expect((await mcp.call({ task: "T001" })).data).toMatchObject({ enabled: false, callsUsed: 1 });
  expect((await mcp.call({ operation: "set-policy", enabled: true })).ok).toBe(true);
  const resumed = await runJson(workspace.root, "critic", "--task", "T001");
  expect(resumed.envelope.data).toMatchObject({ enabled: true, callsUsed: 1, callsRemaining: 2 });
  expect((await mcp.call({ task: "T001" })).data).toEqual(resumed.envelope.data);
  expect(mcp.createMessage).not.toHaveBeenCalled();
});

it("shares whole-feature switches and keeps unknown-host setup gaps visible", async () => {
  const { workspace, brief } = setup;
  const mcp = tool();
  const initial = await runJson(workspace.root, "critic");
  expect(initial.envelope.data).toMatchObject({ enabled: true, next: "unresolved" });
  expect((await mcp.call()).data).toEqual(initial.envelope.data);
  expect(
    (await runJson(workspace.root, "critic", "--off", "--feature", brief.feature)).envelope.data,
  ).toMatchObject({ enabled: false, appliesTo: "whole feature", history: "preserved" });
  const repeatedOff = await runJson(workspace.root, "critic", "--off");
  expect((await mcp.call({ operation: "set-policy", enabled: false })).data).toEqual(
    repeatedOff.envelope.data,
  );
  expect((await mcp.call({ operation: "set-policy", enabled: true })).data).toMatchObject({
    enabled: true,
    gaps: [expect.stringContaining("Setup is incomplete")],
  });
  const repeatedOn = await runJson(workspace.root, "critic", "--on");
  expect((await mcp.call({ operation: "set-policy", enabled: true })).data).toEqual(
    repeatedOn.envelope.data,
  );
  const unresolved = await runJson(workspace.root, "critic", "--preflight");
  expect((await mcp.call({ operation: "preflight" })).data).toEqual(unresolved.envelope.data);
  expect(unresolved.envelope.data).toMatchObject({
    ready: false,
    gaps: [expect.stringContaining("Setup is incomplete")],
  });
  expect(
    (await runJson(workspace.root, "critic", "--on", "--harness", "codex")).envelope.data,
  ).toMatchObject({ enabled: true, config: { harness: "codex" }, gaps: [] });
  const configured = await runJson(workspace.root, "critic");
  expect((await mcp.call()).data).toEqual(configured.envelope.data);
  expect(configured.envelope.data).toMatchObject({ enabled: true, callsUsed: 0 });
  expect(mcp.createMessage).not.toHaveBeenCalled();
});

it("rejects conflicting switches and malformed policy requests without changing the feature", async () => {
  const { workspace, brief } = setup;
  const mcp = tool();
  const path = `${workspace.root}/.visp/features/${brief.feature}/product-state.json`;
  const before = await readFile(path, "utf8");
  for (const flags of [
    ["--on", "--off"],
    ["--on", "--disable"],
    ["--off", "--preflight"],
    ["--off", "--harness", "codex"],
    ["--harness", "codex"],
    ["--reason", "No policy operation selected"],
  ]) {
    const rejected = await runJson(workspace.root, "critic", ...flags);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.envelope.error?.code).toBe("ARTIFACT_INVALID");
  }
  for (const input of [
    { operation: "set-policy" },
    { operation: "set-policy", enabled: "false" },
    { operation: "set-policy", enabled: false, harness: "codex" },
    { operation: "set-policy", enabled: true, config },
    { enabled: false },
  ]) {
    expect((await mcp.call(input)).error?.code).toBe("ARTIFACT_INVALID");
  }
  for (const task of ["T001", "T404"]) {
    const cli = await runJson(workspace.root, "critic", "--off", "--task", task);
    expect(cli.exitCode).not.toBe(0);
    expect((await mcp.call({ operation: "set-policy", enabled: false, task })).error).toEqual(
      cli.envelope.error,
    );
  }
  expect(await readFile(path, "utf8")).toBe(before);
  expect(mcp.createMessage).not.toHaveBeenCalled();
});

it("accepts the same envelope-free host failure through CLI and MCP without manufacturing review credit", async () => {
  const mcp = tool();
  const preset = balancedCritic("codex");
  if (!preset) throw new Error("missing preset");
  expect(
    (await mcp.call({ operation: "configure", task: "T001", config: { ...preset, maxCalls: 3 } }))
      .ok,
  ).toBe(true);
  const prepared = await mcp.call({
    operation: "prepare",
    phase: "understanding",
    task: "T001",
    capabilities: {
      harness: "codex",
      model: preset.model,
      reasoningEffort: "high",
      freshContext: true,
      readOnly: true,
      images: false,
      delegationAllowed: true,
    },
  });
  expect(prepared.ok).toBe(true);
  const result = await runJson(
    setup.workspace.root,
    "critic",
    "--task",
    "T001",
    "--attempt",
    String(prepared.data?.attempt),
    "--failure",
    "Host declined delegation",
    "--failure-kind",
    "permission-denied",
    "--not-invoked",
  );
  expect(result.exitCode).toBe(0);
  expect(result.envelope.data).toMatchObject({
    callsUsed: 1,
    stopped: expect.stringContaining("Host declined delegation"),
  });
  expect((await mcp.call({ task: "T001", phase: "understanding" })).data).toMatchObject({
    callsUsed: 1,
    stopped: expect.stringContaining("Host declined delegation"),
  });
  expect(
    (
      await mcp.call({
        operation: "submit",
        attempt: prepared.data?.attempt,
        failure: "Repeated failure",
      })
    ).ok,
  ).toBe(false);
  const capabilities = {
    harness: "codex",
    model: preset.model,
    reasoningEffort: "high",
    freshContext: true,
    readOnly: true,
    images: false,
    delegationAllowed: true,
  };
  await setup.workspace.write(".visp/recovery-capabilities.json", JSON.stringify(capabilities));
  const reason = "User authorized the same destination after the initial refusal";
  const recovery = await runJson(
    setup.workspace.root,
    "critic",
    "--task",
    "T001",
    "--phase",
    "understanding",
    "--preflight",
    "--retry-after",
    String(prepared.data?.attempt),
    "--reason",
    reason,
    "--capabilities",
    ".visp/recovery-capabilities.json",
  );
  const mcpRecovery = await mcp.call({
    operation: "preflight",
    task: "T001",
    phase: "understanding",
    retryAfter: prepared.data?.attempt,
    reason,
    capabilities,
  });
  expect(recovery.exitCode).toBe(0);
  expect(mcpRecovery.data).toEqual(recovery.envelope.data);
  expect(mcpRecovery.data).toMatchObject({ ready: true, callsUsed: 1 });
  const retry = await runJson(
    setup.workspace.root,
    "critic",
    "--task",
    "T001",
    "--phase",
    "understanding",
    "--prepare",
    "--retry-after",
    String(prepared.data?.attempt),
    "--reason",
    reason,
    "--capabilities",
    ".visp/recovery-capabilities.json",
  );
  expect(retry.exitCode).toBe(0);
  expect(
    (await mcp.call({ operation: "status", task: "T001", phase: "understanding" })).data,
  ).toMatchObject({ callsUsed: 2, lifecycle: { reserved: true, acceptedReview: false } });
});

it("shares source-only discovery between real CLI parser and MCP handler without invoking a model", async () => {
  const { workspace } = setup;
  const mcp = tool();
  const preset = balancedCritic("codex");
  if (!preset) throw new Error("preset");
  expect((await mcp.call({ operation: "configure", task: "T001", config: preset })).ok).toBe(true);
  const capabilities = {
    harness: "codex",
    model: preset.model,
    reasoningEffort: "high",
    freshContext: true,
    readOnly: true,
    images: false,
    delegationAllowed: true,
  };
  await workspace.write(".visp/capabilities.json", JSON.stringify(capabilities));
  const cli = await runJson(
    workspace.root,
    "critic",
    "--task",
    "T001",
    "--source-only",
    "--preflight",
    "--capabilities",
    ".visp/capabilities.json",
  );
  expect(cli.exitCode).toBe(0);
  expect(
    (await mcp.call({ operation: "preflight", task: "T001", sourceOnly: true, capabilities })).data,
  ).toEqual(cli.envelope.data);
  expect(cli.envelope.data).toMatchObject({
    ready: true,
    callsUsed: 0,
    sourceOnly: true,
    requiresImages: false,
  });
  expect(mcp.createMessage).not.toHaveBeenCalled();
});
