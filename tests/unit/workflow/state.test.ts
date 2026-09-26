import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { withStateMutation } from "../../../src/core/file-transaction.js";
import { installHarness } from "../../../src/harness/install.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import {
  authorizedScopes,
  buildFoundationContext,
  loadWorkspace,
  loadWorkspaceForMutation,
  resolveFeature,
} from "../../../src/workflow/state.js";
import { legacyStore } from "../support/legacy-store.js";
import { TestWorkspace, task } from "../support/workspace.js";

const FEATURE = "001-state";

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create({ "src/app.ts": "export const app = true;\n" });
});

afterEach(async () => {
  await workspace.destroy();
});

describe("workspace state loading", () => {
  it("does not mistake a mutation lock on a bare root for project initialization", async () => {
    await rm(`${workspace.root}/.visp`, { recursive: true, force: true });
    await rm(`${workspace.root}/visp.yml`);

    const loaded = await withStateMutation(workspace.root, () => loadWorkspace(workspace.root));

    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error.code).toBe("NOT_INITIALIZED");
    expect((await loadWorkspace(workspace.root)).ok).toBe(false);
  });

  it("loads initialized legacy project records when config and local status are absent", async () => {
    await rm(`${workspace.root}/visp.yml`);
    await rm(`${workspace.root}/.visp/status.json`);

    const loaded = await withStateMutation(workspace.root, () => loadWorkspace(workspace.root));

    expect(loaded.ok).toBe(true);
  });

  it.each([
    ["visp.yml", "unknownRootKey: true\n", "CONFIG_INVALID"],
    [".visp/policy.json", "{}\n", "ARTIFACT_INVALID"],
    [".visp/overrides.json", "{}\n", "ARTIFACT_INVALID"],
    [".visp/status.json", "{}\n", "ARTIFACT_INVALID"],
  ])("fails closed when %s is malformed", async (path, content, expectedCode) => {
    await workspace.write(path, content);

    const loaded = await loadWorkspace(workspace.root);

    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error.code).toBe(expectedCode);
  });

  it("propagates an unreadable feature directory", async () => {
    await workspace.write(".visp/features", "not a directory\n");

    const loaded = await loadWorkspace(workspace.root);

    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error.code).toBe("IO_ERROR");
  });

  it("refuses mutation when transaction recovery cannot inspect its journal directory", async () => {
    await workspace.write(".visp/state/transactions", "not a directory\n");

    const loaded = await loadWorkspaceForMutation(workspace.root);

    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error.code).toBe("IO_ERROR");
  });

  it("recovers the latest tracked feature in memory without rewriting status", async () => {
    await workspace.withFeature(FEATURE);
    const state = await workspace.state();
    await state.files.removeFile(state.paths.status);

    const loaded = await loadWorkspace(workspace.root);

    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.status?.activeFeature).toBe(FEATURE);
  });
});

describe("feature and foundation context resolution", () => {
  it("validates explicit features and reports an absent active feature", async () => {
    const state = await workspace.state();

    expect(resolveFeature(state, FEATURE)).toEqual({ ok: true, value: FEATURE });
    const invalid = resolveFeature(state, "../../outside");
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error.code).toBe("ARTIFACT_INVALID");
    const absent = resolveFeature(state);
    expect(absent.ok).toBe(false);
    expect(!absent.ok && absent.error.code).toBe("NO_ACTIVE_FEATURE");
  });

  it("reports missing harness and enforcement without reading legacy artifacts", async () => {
    await workspace.withFeature(FEATURE);
    await workspace.write(`.visp/features/${FEATURE}/spec.json`, "{}\n");
    const context = await buildFoundationContext(await workspace.state());
    expect(context).toMatchObject({
      ok: true,
      value: { harnessInstalled: false, enforcementInstalled: false },
    });
  });

  it("recognizes exact generic assets and its executable enforcement hook", async () => {
    await workspace.installFoundation();

    const context = await buildFoundationContext(await workspace.state());

    expect(context.ok).toBe(true);
    if (context.ok) {
      expect(context.value.harnessInstalled).toBe(true);
      expect(context.value.enforcementInstalled).toBe(true);
    }
  });

  it("recognizes exact custom Codex critic assets in foundation context", async () => {
    const initial = await workspace.state();
    const config = parse(await readFile(initial.paths.config, "utf8"));
    config.harness = "codex";
    config.critic = {
      harness: "codex",
      enabled: true,
      model: "gpt-6-astra",
      reasoningEffort: "low",
      maxCalls: 2,
      timeoutMs: 180_000,
      maxImageBytes: 4 * 1024 * 1024,
    };
    await writeFile(initial.paths.config, stringify(config), "utf8");

    const configured = await workspace.state();
    const installed = await installHarness(configured.paths, {
      harness: "codex",
      profile: configured.config.profile,
      hooks: [],
      mcp: false,
    });
    if (!installed.ok) throw new Error(installed.error.message);

    const context = await buildFoundationContext(await workspace.state());

    expect(context.ok).toBe(true);
    if (context.ok) expect(context.value.harnessInstalled).toBe(true);
  });

  it("keeps changed files unknown when the repository diff cannot be read", async () => {
    await rm(`${workspace.root}/.git`, { recursive: true, force: true });

    const context = await buildFoundationContext(await workspace.state());

    expect(context.ok).toBe(true);
    if (context.ok) {
      expect(context.value.changedFiles).toBeUndefined();
      expect(context.value.repositoryAvailable).toBe(false);
      expect(context.value.hasBaseline).toBe(false);
    }
  });

  it("keeps historical artifacts independently readable", async () => {
    await prepareCompleteArtifacts();
    for (const kind of [
      "intent",
      "research",
      "spec",
      "plan",
      "tasks",
      "verification",
      "review",
      "traceability",
    ]) {
      expect(await readHistoricalArtifact(kind)).toMatchObject({ ok: true, value: { kind } });
    }
    expect(await readHistoricalArtifact("context manifest")).toEqual({
      ok: true,
      value: undefined,
    });
  });
});

describe("feature artifact failures", () => {
  it.each([
    ["intent", `.visp/features/${FEATURE}/intent.json`],
    ["research", `.visp/features/${FEATURE}/research.json`],
    ["spec", `.visp/features/${FEATURE}/spec.json`],
    ["plan", `.visp/features/${FEATURE}/plan.json`],
    ["tasks", `.visp/features/${FEATURE}/tasks.json`],
    ["verification", `.visp/features/${FEATURE}/evidence/T001/verification.json`],
    ["review", `.visp/features/${FEATURE}/evidence/T001/review.json`],
    ["traceability", `.visp/features/${FEATURE}/traceability.json`],
    ["context manifest", `.visp/features/${FEATURE}/context/T001.manifest.json`],
  ])("propagates malformed %s data", async (label, path) => {
    await prepareCompleteArtifacts();
    await workspace.write(path, "{}\n");

    const context = await readHistoricalArtifact(label);

    expect(context.ok).toBe(false);
    expect(!context.ok && context.error.code).toBe("ARTIFACT_INVALID");
    expect(await readFile(`${workspace.root}/${path}`, "utf8")).toBe("{}\n");
  });
});

describe("authorization and status adapters", () => {
  it("derives CI authorization from a feature task graph", async () => {
    await workspace.withFeature(FEATURE, [task({ id: "T001" }), task({ id: "T002" })]);

    const scopes = await authorizedScopes(await workspace.state(), {
      source: "tasks",
      feature: FEATURE,
    });

    expect(scopes.ok).toBe(true);
    if (scopes.ok) expect(scopes.value.map((marker) => marker.task)).toEqual(["T001", "T002"]);
  });

  it("returns no task-derived authorization without a selected feature or graph", async () => {
    const state = await workspace.state();
    const absent = await authorizedScopes(state, { source: "tasks" });
    const missingGraph = await authorizedScopes(state, {
      source: "tasks",
      feature: "999-missing",
    });

    expect(absent).toEqual({ ok: true, value: [] });
    expect(missingGraph).toEqual({ ok: true, value: [] });
  });

  it("propagates malformed task graphs and active authorization markers", async () => {
    await workspace.withFeature(FEATURE);
    await workspace.write(`.visp/features/${FEATURE}/tasks.json`, "{}\n");
    const taskScopes = await authorizedScopes(await workspace.state(), {
      source: "tasks",
      feature: FEATURE,
    });
    expect(taskScopes.ok).toBe(false);

    await workspace.withFeature(FEATURE);
    await workspace.write(".visp/state/implement-allowed/T999.json", "{}\n");
    const markerScopes = await authorizedScopes(await workspace.state());
    expect(markerScopes.ok).toBe(false);
  });

  it("returns open markers directly when completed-task expansion is disabled", async () => {
    await workspace.withFeature(FEATURE);
    const state = await workspace.state();
    await legacyStore(state).writeImplementMarker({
      kind: "implement-marker",
      createdAt: now(),
      feature: FEATURE,
      task: "T001",
      allowedFiles: ["src/**/*.ts"],
      expectedFiles: ["src/app.ts"],
      forbiddenFiles: [],
    });

    const scopes = await authorizedScopes(await workspace.state(), { includeDone: false });

    expect(scopes.ok).toBe(true);
    if (scopes.ok) expect(scopes.value.map((marker) => marker.task)).toEqual(["T001"]);
  });
});

async function prepareCompleteArtifacts(): Promise<void> {
  await workspace.withFeature(FEATURE);
  await workspace.withSpec(FEATURE, []);
  await workspace.withPlan(FEATURE);
  const state = await workspace.state();
  await legacyStore(state).writeResearch({
    kind: "research",
    createdAt: now(),
    feature: FEATURE,
    mode: "other",
    summary: "The repository owner is known",
    questions: [
      { id: "RQ001", question: "Who owns this?", status: "answered", answer: "This module" },
    ],
    findings: [],
    unknowns: [],
    draft: false,
  });
  await legacyStore(state).writeVerification({
    kind: "verification",
    createdAt: now(),
    feature: FEATURE,
    task: "T001",
    passed: true,
    codeEvidence: "executed",
    commands: [],
    changedFiles: [],
    findings: [],
  });
  await legacyStore(state).writeReview({
    kind: "review",
    createdAt: now(),
    feature: FEATURE,
    task: "T001",
    passed: false,
    basis: "working-tree",
    reviewedFiles: [],
    criteria: [],
    findings: [],
  });
  await legacyStore(state).writeTraceability({
    kind: "traceability",
    createdAt: now(),
    feature: FEATURE,
    links: [],
    qualityLinks: [],
    scenarioLinks: [],
  });
}

async function readHistoricalArtifact(kind: string) {
  const state = await workspace.state();
  switch (kind) {
    case "intent":
      return state.store.readIntent(FEATURE);
    case "research":
      return legacyStore(state).readResearchIfExists(FEATURE);
    case "spec":
      return state.store.readSpecIfExists(FEATURE);
    case "plan":
      return legacyStore(state).readPlanIfExists(FEATURE);
    case "tasks":
      return state.store.readTasksIfExists(FEATURE);
    case "verification":
      return state.store.readVerification(FEATURE, "T001");
    case "review":
      return state.store.readReview(FEATURE, "T001");
    case "traceability":
      return legacyStore(state).readTraceability(FEATURE);
    case "context manifest":
      return state.store.readContextManifest(FEATURE, "T001");
    default:
      throw new Error(`Unknown historical artifact: ${kind}`);
  }
}
