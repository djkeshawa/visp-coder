import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCaptureTools } from "../../../../src/mcp/tools/capture.js";
import { registerEvidenceTools } from "../../../../src/mcp/tools/evidence.js";
import { registerWorkflowTools } from "../../../../src/mcp/tools/workflow.js";
import {
  firstDoneAdvice,
  withFirstDoneAdvice,
} from "../../../../src/workflow/product/first-done-advice.js";
import { readProductAuthorization } from "../../../../src/workflow/product/scopes.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import { runCli, runJson } from "../../cli/support/cli.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const browser = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../src/testing/browser-journey.js", async (original) => ({
  ...(await original<object>()),
  runBrowserJourney: browser.run,
}));

type Handler = (args: Record<string, unknown>, extra: object) => Promise<CallToolResult>;
const MINUTE = 60_000;
// The fixture pins no acceptance tests, so done runs only the worker's checks.
const advice = (minutes: number, pinned = false) =>
  `No visp done yet after ${minutes} minutes: run it now. It runs your checks${pinned ? " and the pinned acceptance tests" : ""}, records the results and lists failures; no review call is spent while a check fails.`;
let workspace: TestWorkspace;
let feature: string;
let authorizedAt: number;
let handlers: Map<string, Handler>;

beforeEach(async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  feature = fixture.brief.feature;
  handlers = new Map();
  const server = {
    registerTool(name: string, _config: unknown, callback: Handler) {
      handlers.set(name, callback);
      return {};
    },
  } as unknown as McpServer;
  registerWorkflowTools(server, workspace.root);
  registerCaptureTools(server, workspace.root);
  registerEvidenceTools(server, workspace.root);
  browser.run.mockResolvedValue({ status: "completed", captures: [], operations: [] });
  authorizedAt = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(authorizedAt);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await workspace.destroy();
});

async function reply(channel: "cli" | "mcp", operation: string) {
  const args = { feature, task: "T001" };
  if (channel === "cli") {
    if (operation === "capture")
      await workspace.write(
        ".visp/journey.json",
        JSON.stringify({ url: "http://127.0.0.1:3000/" }),
      );
    const result = await runJson<Record<string, unknown>>(
      workspace.root,
      operation,
      "--feature",
      feature,
      "--task",
      "T001",
      ...(operation === "capture" ? ["--from", ".visp/journey.json"] : []),
    );
    expect(result.envelope.ok, result.stderr).toBe(true);
    return result.envelope.data as Record<string, unknown>;
  }
  const handler = handlers.get(`visp_${operation}`);
  if (!handler) throw new Error(`Missing ${operation} tool`);
  const result = await handler(
    { ...args, ...(operation === "capture" ? { journey: { url: "http://127.0.0.1:3000/" } } : {}) },
    {},
  );
  expect(result.structuredContent?.ok).toBe(true);
  const data = result.structuredContent?.data as Record<string, unknown>;
  const next = (operation === "next" ? data : data.next) as { evidence?: string[] } | undefined;
  const reminder = next?.evidence?.find((line) => line.startsWith("No visp done yet"));
  if (reminder)
    expect(
      result.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n"),
    ).toContain(reminder);
  return data;
}

function evidence(data: Record<string, unknown>, operation: string) {
  const next = (operation === "next" ? data : data.next) as { evidence: string[] };
  expect(next).toBeDefined();
  return next.evidence;
}

describe.each(["cli", "mcp"] as const)("first done advice through %s", (channel) => {
  it("puts one reminder first after 15 minutes in capture, next and repeated work replies", async () => {
    await reply(channel, "work");
    vi.setSystemTime(authorizedAt + 15 * MINUTE + 59_000);
    for (const operation of ["capture", "next", "work"]) {
      const lines = evidence(await reply(channel, operation), operation);
      expect(lines[0]).toBe(advice(15));
      expect(lines.filter((line) => line.startsWith("No visp done yet"))).toHaveLength(1);
    }
  });

  it("does not advise before 15 minutes", async () => {
    const initial = await reply(channel, "work");
    expect(evidence(initial, "work").join("\n")).not.toContain("No visp done yet");
    vi.setSystemTime(authorizedAt + 15 * MINUTE - 1);
    for (const operation of ["capture", "next", "work"])
      expect(evidence(await reply(channel, operation), operation).join("\n")).not.toContain(
        "No visp done yet",
      );
  });

  it.each(["done", "verify"])(
    "stops after a failed %s execution, even when source changes again",
    async (operation) => {
      await reply(channel, "work");
      vi.setSystemTime(authorizedAt + 15 * MINUTE);
      await reply(channel, operation);
      await workspace.write("src/value.mjs", "export const value = 3;\n");
      vi.setSystemTime(authorizedAt + 45 * MINUTE);
      await reply(channel, "work");
      vi.setSystemTime(authorizedAt + 90 * MINUTE);
      for (const operation of ["capture", "next", "work"])
        expect(evidence(await reply(channel, operation), operation).join("\n")).not.toContain(
          "No visp done yet",
        );
    },
  );
});

it("does not advise for an accepted feature or a closed slice even with no executions", async () => {
  await reply("mcp", "work");
  vi.setSystemTime(authorizedAt + 30 * MINUTE);
  const state = await workspace.state();
  for (const [status, sliceStatus] of [
    ["active", "closed"],
    ["accepted", "in-progress"],
  ] as const) {
    const record = await readProductRecord(state, { feature });
    if (!record.ok) throw new Error(record.error.message);
    const slice = record.value.state.slices.T001;
    if (!slice) throw new Error("Missing slice state");
    const saved = await saveProductState(state, record.value, {
      ...record.value.state,
      status,
      slices: { T001: { ...slice, status: sliceStatus } },
    });
    expect(saved.ok).toBe(true);
    const next = await runProductNext(state, { feature, task: "T001" });
    expect(next.ok).toBe(true);
    expect(next.ok && next.value.evidence.join("\n")).not.toContain("No visp done yet");
  }
});

it("uses slice history or the feature timestamp when authorization time is unavailable", async () => {
  await reply("mcp", "work");
  const state = await workspace.state();
  const record = await readProductRecord(state, { feature });
  if (!record.ok) throw new Error(record.error.message);
  const authorization = await readProductAuthorization(state, record.value);
  if (!authorization.ok || !authorization.value) throw new Error("Missing authorization");
  const slice = record.value.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  vi.setSystemTime(authorizedAt + 30 * MINUTE);
  const historic = {
    ...record.value,
    state: {
      ...record.value.state,
      createdAt: new Date(authorizedAt - 10 * MINUTE).toISOString(),
      sliceHistory: [
        {
          task: "T001",
          from: "closed",
          to: "in-progress",
          createdAt: new Date(authorizedAt + 10 * MINUTE).toISOString(),
          subjectDigest: "current",
          reason: "Reopened",
        },
      ],
    },
  };
  expect(firstDoneAdvice(historic, slice, authorization.value, "current")).toBe(advice(20));
  expect(
    firstDoneAdvice(
      { ...historic, state: { ...historic.state, sliceHistory: [] } },
      slice,
      { ...authorization.value, createdAt: "" },
      "current",
    ),
  ).toBe(advice(40));
  expect(firstDoneAdvice(historic, slice, undefined, "current")).toBeUndefined();
});

it("ignores another slice's run and an older reopened subject, but counts current and later executions", async () => {
  await reply("mcp", "work");
  const state = await workspace.state();
  const record = await readProductRecord(state, { feature });
  if (!record.ok) throw new Error(record.error.message);
  const authorization = await readProductAuthorization(state, record.value);
  if (!authorization.ok || !authorization.value) throw new Error("Missing authorization");
  const slice = record.value.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  vi.setSystemTime(authorizedAt + 30 * MINUTE);
  const reopened = {
    ...record.value,
    state: {
      ...record.value.state,
      sliceHistory: [
        {
          task: "T001",
          from: "closed",
          to: "in-progress",
          createdAt: new Date(authorizedAt).toISOString(),
          subjectDigest: "current",
          reason: "Reopened",
        },
      ],
    },
  };
  for (const [task, subjectDigest, offset, expected] of [
    ["T002", "current", 1, advice(30)],
    ["T001", "old", -1, advice(30)],
    ["T001", "current", -1, undefined],
    ["T001", "later", 1, undefined],
    [undefined, "later", 1, undefined],
  ] as const) {
    const execution = {
      id: "EXEC-test",
      task,
      subjectDigest,
      check: "C001",
      contractDigest: "contract",
      createdAt: new Date(authorizedAt + offset * MINUTE).toISOString(),
      command: "node --test",
      status: "failed" as const,
      exitCode: 1,
      durationMs: 1,
      output: "Failure",
      provenance: "supervisor-executed" as const,
      assertions: "runner-observed" as const,
    };
    expect(
      firstDoneAdvice(
        { ...reopened, state: { ...reopened.state, executions: [execution] } },
        slice,
        authorization.value,
        "current",
      ),
    ).toBe(expected);
  }
});

it("keeps one reminder if the clock crosses a minute boundary while work builds its reply", () => {
  const next = {
    action: "implement" as const,
    objective: "Implement",
    command: "visp done --task T001",
    mayEdit: true,
    evidence: [advice(16), "C001: unassessed"],
  };
  expect(withFirstDoneAdvice(next, advice(15))).toEqual(next);
  expect(withFirstDoneAdvice({ ...next, action: "fix" }, advice(16)).evidence).toEqual(
    next.evidence,
  );
});

it("keeps the reminder visible in CLI text replies", async () => {
  await reply("cli", "work");
  vi.setSystemTime(authorizedAt + 16 * MINUTE);
  await workspace.write(".visp/journey.json", JSON.stringify({ url: "http://127.0.0.1:3000/" }));
  for (const operation of ["capture", "next", "work"]) {
    const result = await runCli(
      workspace.root,
      operation,
      ...(operation === "capture" ? ["--from", ".visp/journey.json"] : []),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(advice(16));
  }
});

describe("pinned acceptance tests in the reminder", () => {
  async function adviceAt(slices: number, baseline: boolean) {
    const loaded = await readProductRecord(await workspace.state(), { feature });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const first = loaded.value.brief.slices[0];
    if (!first) throw new Error("fixture has no slice");
    const brief = {
      ...loaded.value.brief,
      slices: slices === 2 ? [first, { ...first, id: "T002" }] : [first],
      acceptanceBaseline: baseline
        ? [
            {
              command: "node acceptance/value.acceptance.mjs",
              files: [{ path: "acceptance/value.acceptance.mjs", sha256: "0".repeat(64) }],
            },
          ]
        : [],
    } as typeof loaded.value.brief;
    const record = {
      ...loaded.value,
      brief,
      state: {
        ...loaded.value.state,
        slices: { ...loaded.value.state.slices, T002: { status: "pending", contractDigest: "x" } },
      },
    } as typeof loaded.value;
    vi.setSystemTime(authorizedAt + 16 * MINUTE);
    return firstDoneAdvice(
      record,
      first,
      { task: first.id, createdAt: new Date(authorizedAt).toISOString() } as Parameters<
        typeof firstDoneAdvice
      >[2],
      "subject",
    );
  }

  it("names them only on the last open slice of a feature with a pinned baseline", async () => {
    expect(await adviceAt(1, true)).toBe(advice(16, true));
    expect(await adviceAt(2, true)).toBe(advice(16));
    expect(await adviceAt(1, false)).toBe(advice(16));
  });
});
