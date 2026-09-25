import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import { vispError } from "../../../../src/core/errors.js";
import { err } from "../../../../src/core/result.js";
import { capabilityUtilization } from "../../../../src/telemetry/capabilities.js";
import * as probe from "../../../../src/testing/browser-capability.js";
import * as capture from "../../../../src/workflow/evidence/product-capture-execution.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { validateProductFeedback } from "../../../../src/workflow/product/feedback.js";
import {
  runProductNext,
  runProductReview,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
async function project() {
  const p = await productWorkspace();
  projects.push(p);
  const updated = await updateProductBrief(await p.workspace.state(), {
    brief: {
      ...p.brief,
      checks: [
        ...p.brief.checks,
        {
          id: "C002",
          command: {
            kind: "browser-journey",
            journey: {
              url: "http://127.0.0.1:8123",
              actions: [{ kind: "click", selector: "#start" }],
            },
          },
          outcomes: ["O001"],
          files: ["src/value.mjs"],
          environment: "browser",
        },
      ],
      slices: p.brief.slices.map((s) => ({ ...s, checks: [...s.checks, "C002"] })),
    },
    reason: "Exercise the UI in the first slice",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  return p;
}
describe("environment recovery in the product loop", () => {
  it("reuses a recorded startup failure, routes recovery, and accepts an honest unavailable review", async () => {
    vi.spyOn(probe, "probeBrowserCapability").mockResolvedValue();
    const p = await project();
    expect((await runProductWork(await p.workspace.state())).ok).toBe(true);
    await p.workspace.write("src/value.mjs", "export const value=2;");
    const launch = vi.spyOn(capture, "prepareProductCapture").mockResolvedValue(
      err(
        vispError("UNSUPPORTED", "Browser unavailable: permission denied", {
          details: { gap: "browser-unavailable" },
        }),
      ),
    );
    const first = await runProductVerify(await p.workspace.state());
    expect(first).toMatchObject({
      ok: true,
      value: { passed: false, delivery: { status: "unresolved-environment" } },
    });
    await p.workspace.write("src/value.mjs", "export const value = 2;\n");
    const second = await runProductVerify(await p.workspace.state());
    expect(launch).toHaveBeenCalledTimes(1);
    expect(
      second.ok &&
        second.value.executions.find((e) => e.check === "C002")?.reusedEnvironmentFailure,
    ).toBe(true);
    const report = await capabilityUtilization(await p.workspace.state());
    expect(report.ok && report.value.product.executions.recorded).toBe(3); // Two Node runs and one actual browser attempt.
    expect(second.ok && second.value.executions.find((e) => e.check === "C002")?.provenance).toBe(
      "supervisor-reused",
    );
    expect(await runProductNext(await p.workspace.state())).toMatchObject({
      ok: true,
      value: { mayEdit: true, completion: "unresolved-environment" },
    });
    const bundle = await runProductReview(await p.workspace.state());
    if (!bundle.ok) throw new Error(bundle.error.message);
    const review = await runProductReview(await p.workspace.state(), {
      subjectDigest: bundle.value.subjectDigest,
      assessments: [],
      reviewer: { context: "current" },
      feedback: {
        phase: "product",
        dimensions: [
          {
            dimension: "experience",
            status: "unavailable",
            reason: "Browser cannot start",
            evidence: ["C002"],
          },
        ],
        findings: [],
        resolutions: [],
      },
    });
    expect(review.ok).toBe(true);
    await runProductVerify(await p.workspace.state(), { retryEnvironment: true });
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it("reruns the actual check after capability recovery, including a historically closed slice", async () => {
    vi.spyOn(probe, "probeBrowserCapability").mockResolvedValue();
    const p = await project();
    await runProductWork(await p.workspace.state());
    await p.workspace.write("src/value.mjs", "export const value=2;");
    vi.spyOn(capture, "prepareProductCapture").mockResolvedValue(
      err(
        vispError("UNSUPPORTED", "Browser unavailable: permission denied", {
          details: { gap: "browser-unavailable" },
        }),
      ),
    );
    await runProductVerify(await p.workspace.state());
    await runProductWork(await p.workspace.state(), { retryEnvironment: true });
    const next = await runProductNext(await p.workspace.state());
    expect(next).toMatchObject({ ok: true, value: { action: "understand", mayEdit: true } });
    expect(next.ok && next.value.command).toContain("visp verify");
    const state = await p.workspace.state();
    const record = await readProductRecord(state);
    if (!record.ok) throw new Error(record.error.message);
    const slice = record.value.state.slices.T001;
    if (!slice) throw new Error("Missing slice");
    expect(
      (
        await saveProductState(state, record.value, {
          ...record.value.state,
          slices: { ...record.value.state.slices, T001: { ...slice, status: "closed" } },
        })
      ).ok,
    ).toBe(true);
    const closed = await runProductNext(await p.workspace.state());
    expect(closed).toMatchObject({
      ok: true,
      value: { action: "understand", mayEdit: false, completion: "unresolved-environment" },
    });
    expect(closed.ok && closed.value.command).toContain("visp verify");
  });

  it("keeps a real behavioral assertion failure on the product correction path without probing a browser", async () => {
    const launch = vi.spyOn(probe, "probeBrowserCapability").mockResolvedValue();
    const p = await productWorkspace();
    projects.push(p);
    await runProductWork(await p.workspace.state());
    await runProductVerify(await p.workspace.state());
    expect(await runProductNext(await p.workspace.state())).toMatchObject({
      ok: true,
      value: { action: "fix", mayEdit: true },
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("authorizes scoped work despite startup failure, caches the gap and explicitly retries", async () => {
    const launch = vi
      .spyOn(probe, "probeBrowserCapability")
      .mockRejectedValue(new Error("Browser unavailable: setsockopt Operation not permitted"));
    const p = await project();
    expect(await runProductWork(await p.workspace.state(), { task: "T999" })).toMatchObject({
      ok: false,
      error: { code: "TASK_NOT_FOUND" },
    });
    expect(launch).not.toHaveBeenCalled();
    expect(await runProductWork(await p.workspace.state())).toMatchObject({
      ok: true,
      value: { mayEdit: true },
    });
    const record = await readProductRecord(await p.workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.executions).toEqual([]);
    expect(record.value.state.browserCapability?.kind).toBe("permissions");
    expect(record.value.state.slices.T001?.status).toBe("in-progress");
    await p.workspace.write("src/value.mjs", "export const value=3;");
    await runProductWork(await p.workspace.state());
    const before = await readFile(
      join(p.workspace.root, `.visp/features/${p.brief.feature}/product-state.json`),
      "utf8",
    );
    expect(await runProductNext(await p.workspace.state())).toMatchObject({
      ok: true,
      value: { mayEdit: true },
    });
    expect(
      await readFile(
        join(p.workspace.root, `.visp/features/${p.brief.feature}/product-state.json`),
        "utf8",
      ),
    ).toBe(before);
    expect(launch).toHaveBeenCalledTimes(1);
    launch.mockResolvedValue();
    expect(
      await runProductWork(await p.workspace.state(), { retryEnvironment: true }),
    ).toMatchObject({ ok: true, value: { mayEdit: true } });
    expect(launch).toHaveBeenCalledTimes(2);
    const after = await readProductRecord(await p.workspace.state());
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.state.executions).toEqual([]);
    expect(after.value.state.browserCapability?.status).toBe("ready");
  });

  it("rechecks when execution configuration changes", async () => {
    const launch = vi.spyOn(probe, "probeBrowserCapability").mockResolvedValue();
    const p = await project();
    await runProductWork(await p.workspace.state());
    vi.stubEnv("CHROME_BIN", "/missing/new-browser");
    await runProductWork(await p.workspace.state());
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("lets a current unavailable execution explain an unavailable assessment, never a satisfied one", async () => {
    const p = await productWorkspace();
    projects.push(p);
    const record = await readProductRecord(await p.workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    const catalogue = {
      entries: [
        {
          id: "C002",
          kind: "execution" as const,
          status: "unavailable" as const,
          summary: "Browser could not start",
          outcomes: ["O001"],
        },
      ],
      aliases: new Map<string, string>(),
      sources: [],
      sourceClaims: [],
    };
    const feedback = {
      phase: "product",
      dimensions: [
        {
          dimension: "experience",
          status: "unavailable",
          reason: "The browser failed at startup",
          evidence: ["C002"],
        },
      ],
      findings: [],
      resolutions: [],
    };
    expect(
      validateProductFeedback(feedback, record.value, catalogue, { context: "current" }),
    ).toMatchObject({
      ok: true,
      value: { dimensions: [{ status: "unavailable", evidence: ["C002"] }] },
    });
    const dimension = feedback.dimensions[0];
    if (!dimension) throw new Error("Missing test dimension");
    dimension.status = "satisfied";
    expect(
      validateProductFeedback(feedback, record.value, catalogue, { context: "current" }),
    ).toMatchObject({
      ok: false,
      error: { details: { reference: "C002", status: "unavailable" } },
    });
    dimension.status = "unclear";
    dimension.evidence = ["unknown"];
    expect(
      validateProductFeedback(feedback, record.value, catalogue, { context: "current" }),
    ).toMatchObject({ ok: false, error: { details: { reference: "unknown", status: "unknown" } } });
    expect(await runProductReview(await p.workspace.state())).toMatchObject({ ok: true });
  });
});

it("preserves critic capacity during browser recovery, with no call or replacement action", async () => {
  vi.spyOn(probe, "probeBrowserCapability").mockResolvedValue();
  const p = await project();
  await runProductWork(await p.workspace.state());
  await p.workspace.write("src/value.mjs", "export const value=2;");
  vi.spyOn(capture, "prepareProductCapture").mockResolvedValue(
    err(
      vispError("UNSUPPORTED", "Browser unavailable: permission denied", {
        details: { gap: "browser-unavailable" },
      }),
    ),
  );
  await runProductVerify(await p.workspace.state());
  const baseline = await runProductNext(await p.workspace.state());
  await runProductCritic(await p.workspace.state(), {
    operation: "set-policy",
    enabled: true,
    harness: "codex",
  });
  await runProductCritic(await p.workspace.state(), {
    task: "T001",
    operation: "configure",
    config: balancedCritic("codex"),
  });
  const next = await runProductNext(await p.workspace.state());
  expect(next).toMatchObject({
    ok: true,
    value: {
      mayEdit: true,
      completion: "unresolved-environment",
      criticAdvice: {
        status: "suggested",
        command: expect.stringContaining("--retry-environment"),
        guidance: expect.stringContaining("Keep critic capacity for the rendered product"),
      },
    },
  });
  expect(next.ok && next.value.command).toBe(baseline.ok && baseline.value.command);
  expect(
    await runProductCritic(await p.workspace.state(), { task: "T001", operation: "status" }),
  ).toMatchObject({ ok: true, value: { callsUsed: 0 } });
});
