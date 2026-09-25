import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESOURCE, TOOL } from "../../../src/mcp/constants.js";
import {
  type ResourceProject,
  recordEvidence,
  seedDraftFeature,
  seedFeature,
  startProductProject,
  startResourceProject,
} from "./resource-fixture.js";

describe("visp://status on a freshly initialized project", () => {
  let project: ResourceProject;
  beforeAll(async () => {
    project = await startResourceProject("visp-mcp-status-empty-");
  });
  afterAll(async () => {
    await project.close();
  });

  it("serves JSON at the requested URI without inventing product evidence", async () => {
    const read = await project.read(RESOURCE.status);
    expect(read.uri).toBe(RESOURCE.status);
    expect(read.mimeType).toBe("application/json");
    expect(read.value).toMatchObject({
      outcomes: [],
      next: {
        action: "understand",
        command: 'visp feature "<goal>"',
        mayEdit: false,
      },
    });
    expect(read.value).not.toHaveProperty("brief");
    expect(read.value).not.toHaveProperty("state");
  });
});

describe.each(["draft", "active"] as const)("visp://status on a legacy %s feature", (kind) => {
  let project: ResourceProject;
  let feature: string;
  beforeAll(async () => {
    project = await startResourceProject("visp-mcp-status-legacy-");
    if (kind === "draft") feature = await seedDraftFeature(project.root);
    else {
      feature = (await seedFeature(project.root)).id;
      await recordEvidence(project.root, feature, { verification: false, review: true });
    }
  });
  afterAll(async () => {
    await project.close();
  });

  it("guides migration without changing historical bytes or reporting fresh evidence", async () => {
    const directory = join(project.root, ".visp/features", feature);
    const before = await snapshot(directory);
    const status = await project.readJson(RESOURCE.status);
    expect(status).toMatchObject({
      feature,
      outcomes: [],
      next: {
        action: "understand",
        mayEdit: false,
        command: `visp migrate --feature ${feature} --dry-run`,
        evidence: [expect.stringContaining("MIGRATION_REQUIRED")],
      },
    });
    expect(status).not.toHaveProperty("state");
    expect(status).not.toHaveProperty("brief");
    expect(await snapshot(directory)).toEqual(before);
  });
});

describe("visp://status for the product workflow", () => {
  let project: Awaited<ReturnType<typeof startProductProject>>;
  beforeAll(async () => {
    project = await startProductProject();
    await project.client.callTool({ name: TOOL.work, arguments: { task: "T001" } });
    await project.client.callTool({ name: TOOL.verify, arguments: { task: "T001" } });
  });
  afterAll(async () => {
    await project.close();
  });

  it("exposes outcomes and actual failed executions without writing on read", async () => {
    const directory = join(project.root, ".visp/features", project.brief.feature);
    const before = await snapshot(directory);
    const status = await project.readJson(RESOURCE.status);
    expect(status).toMatchObject({
      feature: project.brief.feature,
      next: { action: "fix", task: "T001", mayEdit: true },
      outcomes: [{ id: "O001", statement: "The public value is two", behavior: "failed" }],
    });
    expect(status).not.toHaveProperty("state");
    expect(status).not.toHaveProperty("brief");
    const detailed = await project.client.callTool({
      name: TOOL.status,
      arguments: { detail: true },
    });
    expect(detailed.structuredContent).toMatchObject({
      data: {
        brief: project.brief,
        state: {
          executions: [{ check: "C001", status: "failed", provenance: "supervisor-executed" }],
        },
      },
    });
    expect(await snapshot(directory)).toEqual(before);
  });
});

async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const pairs = await Promise.all(
    entries.map(
      async (entry): Promise<[string, string]> => [
        entry.name,
        entry.isDirectory()
          ? JSON.stringify(await snapshot(join(directory, entry.name)))
          : (await readFile(join(directory, entry.name))).toString("base64"),
      ],
    ),
  );
  return Object.fromEntries(pairs);
}
