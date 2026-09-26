import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { readObservationViews } from "../../../../src/workflow/evidence/observations.js";
import { stableContextHash } from "../../support/legacy-context.js";
import { recordObservation } from "../../support/legacy-observations.js";
import { legacyStore } from "../../support/legacy-store.js";
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
    const spec = await legacyStore(state).readSpec(FEATURE);
    if (!spec.ok) throw new Error(spec.error.message);
    const requirement = spec.value.requirements[0];
    if (!requirement) throw new Error("missing requirement");
    const criterion = requirement.criteria[0];
    if (!criterion) throw new Error("missing criterion");
    const wrote = await legacyStore(state).writeSpec({
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
    const spec = await legacyStore(state).readSpec(FEATURE);
    if (!spec.ok) throw new Error(spec.error.message);
    const wrote = await legacyStore(state).writeSpec({
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
    const spec = await legacyStore(state).readSpec(FEATURE);
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
});
