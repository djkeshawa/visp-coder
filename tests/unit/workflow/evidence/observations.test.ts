import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import {
  decorateUncheckedCriteria,
  readObservationViews,
  recordObservation,
} from "../../../../src/workflow/evidence/observations.js";
import { stableContextHash } from "../../support/legacy-context.js";
import { pngHeader, TestWorkspace, task } from "../../support/workspace.js";

const FEATURE = "001-observe-behaviour";

let workspace: TestWorkspace;
const SCREEN = pngHeader(1280, 720);

beforeEach(async () => {
  workspace = await TestWorkspace.create({
    "src/app.ts": "export const ready = true;\n",
    "evidence/screen.png": SCREEN,
  });
  await workspace.withFeature(FEATURE, [
    task({ requirements: ["REQ001"], allowedFiles: ["src/**", "tests/**"] }),
  ]);
  await workspace.withSpec(FEATURE, [
    {
      id: "REQ001",
      statement: "The application is ready",
      priority: "must",
      criteria: [
        {
          id: "AC001",
          statement: "The ready state is visible",
          verification: "inspection: open the application",
        },
      ],
    },
  ]);
  await workspace.ensureContext(FEATURE);
});

afterEach(async () => {
  await workspace.destroy();
});

describe("advisory observations", () => {
  it("copies project artifacts, hashes them, and reads the receipt as fresh", async () => {
    const state = await workspace.state();
    const recorded = await recordObservation(state, {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "satisfied",
      note: "The ready state appeared after loading.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application", "Wait for the ready state"],
    });

    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    expect(recorded.value.requirement).toBe("REQ001");
    expect(recorded.value.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded.value.attachments).toHaveLength(1);
    const attachment = recorded.value.attachments[0];
    expect(attachment?.sourcePath).toBe("evidence/screen.png");
    expect(attachment?.sha256).toBe(createHash("sha256").update(SCREEN).digest("hex"));
    expect(attachment?.dimensions).toEqual({ width: 1280, height: 720 });
    expect(attachment?.storedPath).toContain(
      `.visp/features/${FEATURE}/evidence/observation-attachments/`,
    );
    expect(await readFile(state.paths.absolute(attachment?.storedPath ?? ""))).toEqual(SCREEN);
    expect(recorded.value.viewport).toEqual({ width: 1280, height: 720 });
    expect(recorded.value.route).toBe("/");
    expect(recorded.value.steps).toEqual(["Load the application", "Wait for the ready state"]);

    const pack = await state.store.readContextPack(FEATURE, "T001");
    const manifest = await state.store.readContextManifest(FEATURE, "T001");
    if (!pack.ok || !pack.value || !manifest.ok || !manifest.value) {
      throw new Error("missing compiled context");
    }
    expect(recorded.value.contextManifestHash).toBe(
      stableContextHash(pack.value, manifest.value.graphSnapshotId),
    );

    const views = await readObservationViews(state, FEATURE, "T001");
    expect(views.ok && views.value).toHaveLength(1);
    expect(views.ok && views.value[0]).toMatchObject({ stale: false, staleReasons: [] });
  });

  it("refuses a browser observation without a screenshot or video", async () => {
    const result = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "satisfied",
      note: "It looked correct.",
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application"],
      artifacts: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("screenshot or video");
  });

  it("refuses a viewport screenshot whose pixels contradict the declared viewport", async () => {
    await workspace.write("evidence/wrong-size.png", pngHeader(545, 844));

    const result = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "satisfied",
      note: "Claimed to be a narrow viewport.",
      artifacts: ["evidence/wrong-size.png"],
      viewport: { width: 390, height: 844 },
      route: "/",
      steps: ["Load the application"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("does not match viewport");
    await expect(
      readdir(join((await workspace.state()).paths.evidenceDir(FEATURE), "T001", "observations")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deduplicates an identical receipt and reuses matching attachment bytes", async () => {
    const state = await workspace.state();
    const options = {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser" as const,
      result: "satisfied" as const,
      note: "The ready state appeared after loading.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application"],
    };

    const first = await recordObservation(state, options);
    const second = await recordObservation(state, options);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);

    const log = await state.store.readObservations(FEATURE, "T001");
    expect(log.ok && log.value?.observations).toHaveLength(1);
  });

  it("includes browser engine and platform in the stable observation subject", async () => {
    const state = await workspace.state();
    const base = {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser" as const,
      result: "satisfied" as const,
      note: "The ready state appeared after loading.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application"],
    };

    const chromium = await recordObservation(state, {
      ...base,
      environment: { browserEngine: "chromium", platform: "linux" },
    });
    const webkit = await recordObservation(state, {
      ...base,
      environment: { browserEngine: "webkit", platform: "linux" },
    });

    expect(chromium.ok && webkit.ok).toBe(true);
    if (!chromium.ok || !webkit.ok) return;
    expect(chromium.value.subjectHash).not.toBe(webkit.value.subjectHash);
    expect(webkit.value.environment).toEqual({ browserEngine: "webkit", platform: "linux" });
  });

  it("marks a semantic receipt stale when stable context-pack content is altered", async () => {
    const state = await workspace.state();
    const recorded = await recordObservation(state, {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "manual",
      result: "satisfied",
      note: "Observed before the reading plan was altered.",
    });
    if (!recorded.ok) throw new Error(recorded.error.message);

    const packPath = state.paths.contextFile(FEATURE, "T001");
    const pack = JSON.parse(await readFile(packPath, "utf8"));
    pack.unknowns = [...pack.unknowns, "A new unresolved dependency"];
    await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    const before = await readFile(packPath, "utf8");

    const views = await readObservationViews(state, FEATURE, "T001");

    expect(views.ok && views.value[0]).toMatchObject({
      stale: true,
      staleReasons: ["context pack stable content changed"],
    });
    expect(await readFile(packPath, "utf8")).toBe(before);
  });

  it("stales a receipt when its route, viewport, capture mode, or environment is altered", async () => {
    const state = await workspace.state();
    const recorded = await recordObservation(state, {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "satisfied",
      note: "The ready state appeared after loading.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      capture: "viewport",
      route: "/",
      steps: ["Load the application"],
      environment: { browserEngine: "chromium", platform: "linux" },
    });
    if (!recorded.ok) throw new Error(recorded.error.message);

    const path = state.paths.evidenceFile(FEATURE, "T001", "observations.json");
    const original = JSON.parse(await readFile(path, "utf8")) as {
      observations: Array<Record<string, unknown>>;
    };
    const variants: Array<[string, (receipt: Record<string, unknown>) => void]> = [
      ["route", (receipt) => (receipt.route = "/changed")],
      ["viewport", (receipt) => (receipt.viewport = { width: 390, height: 844 })],
      ["capture", (receipt) => (receipt.capture = "full-page")],
      ["environment", (receipt) => (receipt.environment = { browserEngine: "webkit" })],
    ];

    for (const [field, mutate] of variants) {
      const changed = structuredClone(original);
      const receipt = changed.observations[0];
      if (!receipt) throw new Error("missing observation receipt");
      mutate(receipt);
      await writeFile(path, `${JSON.stringify(changed, null, 2)}\n`, "utf8");

      const views = await readObservationViews(state, FEATURE, "T001");
      expect(views.ok && views.value[0]?.staleReasons, field).toContain(
        "observation subject changed",
      );
    }
  });

  it("rolls back a newly stored attachment when receipt publication fails", async () => {
    const state = await workspace.state();
    const recorded = await recordObservation(
      state,
      {
        feature: FEATURE,
        task: "T001",
        criterion: "AC001",
        source: "browser",
        result: "satisfied",
        note: "The ready state appeared after loading.",
        artifacts: ["evidence/screen.png"],
        viewport: { width: 1280, height: 720 },
        route: "/",
        steps: ["Load the application"],
      },
      {
        afterMutation(applied) {
          if (applied === 1) throw new Error("receipt publication failed");
        },
      },
    );

    expect(recorded.ok).toBe(false);
    await expect(readdir(state.paths.observationAttachmentsStoreDir(FEATURE))).resolves.toEqual([]);
    const log = await state.store.readObservations(FEATURE, "T001");
    expect(log).toEqual({ ok: true, value: undefined });
  });

  it("stores identical attachment bytes once across tasks in the feature", async () => {
    await workspace.withFeature(FEATURE, [
      task({ id: "T001", requirements: ["REQ001"] }),
      task({ id: "T002", requirements: ["REQ001"] }),
    ]);
    await workspace.ensureContext(FEATURE, "T002");
    const state = await workspace.state();
    const base = {
      feature: FEATURE,
      criterion: "AC001",
      source: "manual" as const,
      result: "satisfied" as const,
      note: "The same captured state applies to this bounded task.",
      artifacts: ["evidence/screen.png"],
    };

    const first = await recordObservation(state, { ...base, task: "T001" });
    const second = await recordObservation(state, { ...base, task: "T002" });
    if (!first.ok || !second.ok) throw new Error("recording failed");

    expect(second.value.attachments[0]?.storedPath).toBe(first.value.attachments[0]?.storedPath);
    expect(await readdir(state.paths.observationAttachmentsStoreDir(FEATURE))).toHaveLength(1);
  });

  it("replaces an earlier receipt for the same criterion and reproduction state", async () => {
    const state = await workspace.state();
    const base = {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser" as const,
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application"],
    };
    const first = await recordObservation(state, {
      ...base,
      result: "unclear",
      note: "The state could not be settled yet.",
    });
    const second = await recordObservation(state, {
      ...base,
      result: "failed",
      note: "The ready state overlaps the toolbar.",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    const log = await state.store.readObservations(FEATURE, "T001");
    expect(log.ok && log.value?.observations).toHaveLength(1);
    expect(log.ok && log.value?.observations[0]?.id).toBe(second.value.id);
    expect(log.ok && log.value?.observations[0]?.result).toBe("failed");
  });

  it("marks one screenshot reused for different reproduction steps as stale", async () => {
    const state = await workspace.state();
    const first = await recordObservation(state, {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "satisfied",
      note: "The ready state appeared.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application", "Wait for the ready state"],
    });
    if (!first.ok) throw new Error(first.error.message);
    const second = await recordObservation(state, {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "failed",
      note: "The restart state was not restored.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Complete the workflow", "Press restart"],
    });
    if (!second.ok) throw new Error(second.error.message);

    expect(second.value.attachments[0]?.storedPath).toBe(first.value.attachments[0]?.storedPath);

    const views = await readObservationViews(state, FEATURE, "T001");
    expect(views.ok).toBe(true);
    if (!views.ok) return;
    expect(views.value).toHaveLength(2);
    expect(views.value.every((view) => view.stale)).toBe(true);
    expect(
      views.value.every((view) =>
        view.staleReasons.includes("attachment reused across different reproduction steps"),
      ),
    ).toBe(true);
  });

  it("refuses to trust a corrupted content-addressed attachment", async () => {
    const state = await workspace.state();
    const options = {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser" as const,
      result: "satisfied" as const,
      note: "The ready state appeared after loading.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application"],
    };

    const first = await recordObservation(state, options);
    if (!first.ok) throw new Error(first.error.message);
    const firstAttachment = first.value.attachments[0];
    if (!firstAttachment) throw new Error("missing attachment");
    await writeFile(state.paths.absolute(firstAttachment.storedPath), "tampered", "utf8");

    const stale = await readObservationViews(state, FEATURE, "T001");
    expect(stale.ok && stale.value[0]?.staleReasons).toContain(
      `attachment changed: ${firstAttachment.storedPath}`,
    );

    const second = await recordObservation(state, options);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toContain("content-addressed attachment");
  });

  it("refuses a criterion the task does not own", async () => {
    const state = await workspace.state();
    const spec = await state.store.readSpec(FEATURE);
    if (!spec.ok) throw new Error(spec.error.message);
    const wrote = await state.store.writeSpec({
      ...spec.value,
      requirements: [
        ...spec.value.requirements,
        {
          id: "REQ002",
          statement: "An unrelated requirement",
          priority: "must",
          criteria: [{ id: "AC002", statement: "Unrelated", verification: "inspection: look" }],
        },
      ],
    });
    if (!wrote.ok) throw new Error(wrote.error.message);

    const result = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC002",
      source: "manual",
      result: "unclear",
      note: "Could not settle it.",
      artifacts: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("does not own");
  });

  it("records advisory observations for an owned quality requirement criterion", async () => {
    await workspace.withFeature(FEATURE, [
      task({
        requirements: [],
        qualityRequirements: ["NFR001"],
        allowedFiles: ["src/**"],
      }),
    ]);
    const state = await workspace.state();
    const spec = await state.store.readSpec(FEATURE);
    if (!spec.ok) throw new Error(spec.error.message);
    const wrote = await state.store.writeSpec({
      ...spec.value,
      requirements: [],
      qualityRequirements: [
        {
          id: "NFR001",
          category: "performance",
          statement: "The interaction remains responsive",
          target: "The interaction completes within 100 ms",
          priority: "must",
          criteria: [
            {
              id: "AC002",
              statement: "Animation remains visually smooth",
              verificationKind: "inspection",
              verification: "inspection: exercise the interaction and look for visible stalls",
              verificationLayer: "functional",
              verificationEnvironment: "browser",
            },
          ],
        },
      ],
    });
    if (!wrote.ok) throw new Error(wrote.error.message);
    await workspace.ensureContext(FEATURE);

    const result = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC002",
      source: "manual",
      result: "unclear",
      note: "No obvious stall was visible, but this is not a timing measurement.",
      artifacts: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requirement).toBe("NFR001");
    expect(result.value.criterion).toBe("AC002");
  });

  it("refuses absolute artifact paths before reading the ambient filesystem", async () => {
    const result = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "manual",
      result: "satisfied",
      note: "External evidence must not be copied.",
      artifacts: ["/etc/hosts"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ARTIFACT_INVALID");
      expect(result.error.message).toContain("project-relative");
    }
  });

  it.each(["../outside.png", "evidence/../screen.png", "C:\\outside.png", "\\\\host\\share.png"])(
    "refuses unsafe artifact path %s before resolving it",
    async (artifact) => {
      const result = await recordObservation(await workspace.state(), {
        feature: FEATURE,
        task: "T001",
        criterion: "AC001",
        source: "manual",
        result: "satisfied",
        note: "Unsafe paths must not be resolved.",
        artifacts: [artifact],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("ARTIFACT_INVALID");
      const log = await (await workspace.state()).store.readObservations(FEATURE, "T001");
      expect(log.ok && log.value).toBeUndefined();
    },
  );

  it("marks a receipt stale when the spec changes", async () => {
    const recorded = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "satisfied",
      note: "Observed before the contract changed.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application"],
    });
    if (!recorded.ok) throw new Error(recorded.error.message);

    const state = await workspace.state();
    const spec = await state.store.readSpec(FEATURE);
    if (!spec.ok) throw new Error(spec.error.message);
    const requirement = spec.value.requirements[0];
    if (!requirement) throw new Error("missing requirement");
    const criterion = requirement.criteria[0];
    if (!criterion) throw new Error("missing criterion");
    const wrote = await state.store.writeSpec({
      ...spec.value,
      requirements: [
        {
          ...requirement,
          criteria: [{ ...criterion, statement: "The changed ready state is visible" }],
        },
      ],
    });
    if (!wrote.ok) throw new Error(wrote.error.message);

    const views = await readObservationViews(await workspace.state(), FEATURE, "T001");
    expect(views.ok && views.value[0]?.stale).toBe(true);
    expect(views.ok && views.value[0]?.staleReasons).toEqual(["criterion contract changed"]);
  });

  it("keeps a new receipt fresh across delivery-only spec edits and no-op context rebuilds", async () => {
    const recorded = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "satisfied",
      note: "Observed against stable semantic inputs.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application"],
    });
    if (!recorded.ok) throw new Error(recorded.error.message);

    const state = await workspace.state();
    const spec = await state.store.readSpec(FEATURE);
    if (!spec.ok) throw new Error(spec.error.message);
    const wrote = await state.store.writeSpec({
      ...spec.value,
      summary: "Delivery wording changed without changing the owned criterion",
    });
    if (!wrote.ok) throw new Error(wrote.error.message);

    const { buildContextPack } = await import("../../support/legacy-context.js");
    const rebuilt = await buildContextPack(await workspace.state(), {
      feature: FEATURE,
      taskId: "T001",
      repositoryFiles: ["src/app.ts"],
    });
    if (!rebuilt.ok) throw new Error(rebuilt.error.message);

    const views = await readObservationViews(await workspace.state(), FEATURE, "T001");
    expect(views.ok && views.value[0]).toMatchObject({ stale: false, staleReasons: [] });
  });

  it("marks a semantic receipt stale when selected source bytes change after capture", async () => {
    const recorded = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "manual",
      result: "satisfied",
      note: "Observed against the current implementation bytes.",
    });
    if (!recorded.ok) throw new Error(recorded.error.message);

    await workspace.write("src/app.ts", "export const ready = false;\n");

    const views = await readObservationViews(await workspace.state(), FEATURE, "T001");
    expect(views.ok && views.value[0]?.staleReasons).toContain("relevant source changed");
  });

  it("refuses to mint a semantic receipt from a legacy context digest", async () => {
    const state = await workspace.state();
    const pack = await state.store.readContextPack(FEATURE, "T001");
    const manifest = await state.store.readContextManifest(FEATURE, "T001");
    if (!pack.ok || !pack.value || !manifest.ok || !manifest.value) {
      throw new Error("missing compiled context");
    }
    const legacyManifest = {
      ...manifest.value,
      contextHash: hashValue(pack.value.files.map((file) => [file.path, file.hash])),
    };
    const manifestPath = state.paths.contextManifest(FEATURE, "T001");
    await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8");
    const before = await readFile(manifestPath, "utf8");

    const recorded = await recordObservation(state, {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "manual",
      result: "satisfied",
      note: "This must wait for a stable context rebuild.",
    });

    expect(recorded).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED", recovery: "visp context T001" },
    });
    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect(await state.store.readObservations(FEATURE, "T001")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("continues evaluating a legacy receipt with its full artifact hashes", async () => {
    const state = await workspace.state();
    const recorded = await recordObservation(state, {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "manual",
      result: "satisfied",
      note: "A legacy-compatible observation.",
    });
    if (!recorded.ok) throw new Error(recorded.error.message);

    const path = `.visp/features/${FEATURE}/evidence/T001/observations.json`;
    const log = JSON.parse(await readFile(join(workspace.root, path), "utf8")) as {
      observations: Array<Record<string, unknown>>;
    };
    const spec = await state.store.readSpec(FEATURE);
    const manifest = await state.store.readContextManifest(FEATURE, "T001");
    const pack = await state.store.readContextPack(FEATURE, "T001");
    if (!spec.ok || !manifest.ok || !manifest.value || !pack.ok || !pack.value) {
      throw new Error("missing legacy inputs");
    }
    const legacyManifest = {
      ...manifest.value,
      contextHash: hashValue(pack.value.files.map((file) => [file.path, file.hash])),
    };
    const manifestPath = state.paths.contextManifest(FEATURE, "T001");
    await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8");
    delete log.observations[0]?.subjectHash;
    if (log.observations[0]) {
      log.observations[0].specHash = hashValue(spec.value);
      log.observations[0].contextManifestHash = hashValue(legacyManifest);
    }
    await workspace.write(path, `${JSON.stringify(log, null, 2)}\n`);
    const beforeManifest = await readFile(manifestPath, "utf8");
    const beforeLog = await readFile(join(workspace.root, path), "utf8");

    const views = await readObservationViews(await workspace.state(), FEATURE, "T001");
    expect(views.ok && views.value[0]).toMatchObject({ stale: false, staleReasons: [] });
    expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
    expect(await readFile(join(workspace.root, path), "utf8")).toBe(beforeLog);
  });

  it("marks a receipt stale after source and context change and does not decorate", async () => {
    const recorded = await recordObservation(await workspace.state(), {
      feature: FEATURE,
      task: "T001",
      criterion: "AC001",
      source: "browser",
      result: "satisfied",
      note: "Observed against the original context.",
      artifacts: ["evidence/screen.png"],
      viewport: { width: 1280, height: 720 },
      route: "/",
      steps: ["Load the application"],
    });
    if (!recorded.ok) throw new Error(recorded.error.message);

    await workspace.write("src/app.ts", "export const ready = false;\n");
    const { buildContextPack } = await import("../../support/legacy-context.js");
    const rebuilt = await buildContextPack(await workspace.state(), {
      feature: FEATURE,
      taskId: "T001",
      repositoryFiles: ["src/app.ts"],
    });
    if (!rebuilt.ok) throw new Error(rebuilt.error.message);

    const views = await readObservationViews(await workspace.state(), FEATURE, "T001");
    expect(views.ok && views.value[0]?.staleReasons).toEqual([
      "context manifest changed",
      "relevant source changed",
    ]);
    if (!views.ok) return;
    const decorated = decorateUncheckedCriteria(
      [
        {
          criterion: "AC001",
          requirement: "REQ001",
          statement: "The ready state is visible",
          outcome: "unchecked",
          detail: "declared inspection",
        },
      ],
      views.value,
    );
    expect(decorated[0]?.detail).toBe("declared inspection");
  });
});
