import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSecurityError } from "../../../../src/testing/browser-files.js";
import { BrowserUnavailableError } from "../../../../src/testing/chrome-transport.js";
import { runProductCapture } from "../../../../src/workflow/evidence/product-capture.js";
import { browserEnvironmentIdentity } from "../../../../src/workflow/product/environment.js";
import {
  browserExecutionEnvironmentIdentity,
  supportedHostCaptureRecovery,
} from "../../../../src/workflow/product/environment-model.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";

const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../src/testing/browser-journey.js", async (original) => ({
  ...(await original<object>()),
  runBrowserJourney: runner.run,
}));

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const project of projects.splice(0)) await project.workspace.destroy();
});

describe("capture transport recovery", () => {
  it("offers the equivalent MCP capture arguments after shell startup failure", async () => {
    const project = await productWorkspace();
    projects.push(project);
    runner.run.mockRejectedValueOnce(
      new BrowserUnavailableError("Chrome exited before becoming ready"),
    );
    const journey = {
      url: "http://127.0.0.1:3000/",
      actions: [{ kind: "click", selector: "#go" }],
    };

    const result = await runProductCapture(await project.workspace.state(), {
      feature: project.brief.feature,
      task: "T001",
      journey,
      binary: "/opt/chrome",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "UNSUPPORTED",
        details: {
          gap: "browser-unavailable",
          supportedHostOption: {
            transport: "mcp",
            tool: "visp_capture",
            arguments: {
              feature: project.brief.feature,
              task: "T001",
              journey,
              binary: "/opt/chrome",
            },
          },
        },
      },
    });
    expect(!result.ok && result.error.recovery).toContain("visp_capture");
    expect(!result.ok && result.error.recovery).not.toContain("--retry-environment");
  });

  it("does not route URL or browser security policy failures through another transport", async () => {
    const project = await productWorkspace();
    projects.push(project);
    runner.run.mockRejectedValueOnce(new BrowserSecurityError("URL is outside the project policy"));

    const result = await runProductCapture(await project.workspace.state(), {
      feature: project.brief.feature,
      journey: { url: "http://example.invalid/" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED", details: { gap: "browser-security" } },
    });
    expect(!result.ok && result.error.recovery).toBeUndefined();
    expect(!result.ok && result.error.details).not.toHaveProperty("supportedHostOption");
  });

  it("keeps the original replay run ID in shared recovery output", async () => {
    const project = await productWorkspace();
    projects.push(project);
    runner.run.mockResolvedValueOnce({ status: "completed", captures: [], operations: [] });
    const first = await runProductCapture(await project.workspace.state(), {
      feature: project.brief.feature,
      task: "T001",
      journey: { url: "http://127.0.0.1:3000/" },
    });
    if (!first.ok) throw new Error(first.error.message);
    runner.run.mockRejectedValueOnce(
      new BrowserUnavailableError("Chrome exited before becoming ready"),
    );

    const replay = await runProductCapture(await project.workspace.state(), {
      replay: first.value.runId,
      binary: "/opt/chrome",
    });

    expect(replay).toMatchObject({
      ok: false,
      error: {
        details: {
          supportedHostOption: {
            arguments: {
              feature: project.brief.feature,
              task: "T001",
              replay: first.value.runId,
              binary: "/opt/chrome",
            },
          },
        },
      },
    });
  });

  it("records readiness for the environment that performed a successful capture", async () => {
    const project = await productWorkspace();
    projects.push(project);
    runner.run.mockResolvedValueOnce({ status: "completed", captures: [], operations: [] });

    const result = await runProductCapture(await project.workspace.state(), {
      feature: project.brief.feature,
      journey: { url: "http://127.0.0.1:3000/" },
    });
    expect(result.ok).toBe(true);
    const record = await readProductRecord(await project.workspace.state(), {
      feature: project.brief.feature,
    });
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.browserCapability).toMatchObject({
      status: "ready",
      kind: "startup-capture",
    });
    expect(record.value.state.browserCapability?.environment).toBe(
      await browserEnvironmentIdentity(project.workspace.root),
    );
  });

  it("keeps a custom executable capability separate from the default identity", async () => {
    const project = await productWorkspace();
    projects.push(project);
    runner.run.mockResolvedValueOnce({ status: "completed", captures: [], operations: [] });

    const result = await runProductCapture(await project.workspace.state(), {
      feature: project.brief.feature,
      journey: { url: "http://127.0.0.1:3000/" },
      binary: "/opt/custom-chrome",
    });
    expect(result.ok).toBe(true);
    const record = await readProductRecord(await project.workspace.state(), {
      feature: project.brief.feature,
    });
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.browserCapability?.environment).toBe(
      await browserExecutionEnvironmentIdentity(project.workspace.root, "/opt/custom-chrome"),
    );
    expect(record.value.state.browserCapability?.environment).not.toBe(
      await browserEnvironmentIdentity(project.workspace.root),
    );
  });
});

it("serializes a replay as replay rather than silently changing its meaning", () => {
  expect(
    supportedHostCaptureRecovery({ feature: "feature", task: "T001", replay: "CAPRUN-1" }).option,
  ).toEqual({
    transport: "mcp",
    tool: "visp_capture",
    arguments: { feature: "feature", task: "T001", replay: "CAPRUN-1" },
  });
});

it("leaves current-selection recovery unspecified and preserves replay precedence", () => {
  const current = supportedHostCaptureRecovery({});
  expect(current.option).toEqual({
    transport: "mcp",
    tool: "visp_capture",
    arguments: {},
  });
  expect(current.message).toContain("If unavailable, retain the browser gap");
  const replay = supportedHostCaptureRecovery({
    replay: "CAPRUN-original",
    journey: { url: "http://127.0.0.1:3000/different-input" },
  });
  expect(replay.option.arguments).toEqual({ replay: "CAPRUN-original" });
  expect(replay.message).not.toContain("different-input");
});
