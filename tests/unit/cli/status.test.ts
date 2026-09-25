import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductNext, ProductStatus } from "../../../src/workflow/product/index.js";
import { productWorkspace } from "../support/product-workspace.js";
import { TestWorkspace } from "../support/workspace.js";
import { runJson } from "./support/cli.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.destroy()));
});

describe("product status CLI", () => {
  it("directs an empty project to the original request without creating state", async () => {
    const w = await TestWorkspace.create();
    workspaces.push(w);
    const next = await runJson<ProductNext>(w.root, "next");
    expect(next.envelope.data).toMatchObject({ action: "understand", mayEdit: false });
    expect(next.envelope.data?.command).toContain("visp feature");
    expect((await runJson<ProductStatus>(w.root, "status")).envelope.data?.outcomes).toEqual([]);
  });
  it("reports migration for historical state without trying to repair or interpret legacy drafts", async () => {
    const w = await TestWorkspace.create();
    workspaces.push(w);
    await w.installFoundation();
    await w.withFeature("001-history");
    const path = join(w.root, ".visp/features/001-history/tasks.json");
    await w.write(".visp/features/001-history/tasks.json", "{ incomplete historical bytes\n");
    const before = await readFile(path, "utf8");
    const status = await runJson<ProductStatus>(w.root, "status");
    expect(status.envelope.data?.next.command).toContain("migrate");
    expect((await runJson(w.root, "work")).envelope.error?.code).toBe("MIGRATION_REQUIRED");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("keeps absent evidence unassessed and both reads leave the current state byte-identical", async () => {
    const { workspace: w, brief } = await productWorkspace();
    workspaces.push(w);
    const path = join(w.root, ".visp/features", brief.feature, "product-state.json");
    const before = await readFile(path, "utf8");
    const status = await runJson<ProductStatus>(w.root, "status");
    expect(status.envelope.data?.outcomes[0]).toMatchObject({
      behavior: "unassessed",
      review: "unassessed",
      satisfied: false,
    });
    expect((await runJson<ProductNext>(w.root, "next")).envelope.data?.command).toContain(
      "visp work",
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("rejects corrupted current state and unknown selected slices", async () => {
    const { workspace: w, brief } = await productWorkspace();
    workspaces.push(w);
    expect((await runJson(w.root, "next", "--task", "T999")).envelope.error?.code).toBe(
      "TASK_NOT_FOUND",
    );
    await w.write(`.visp/features/${brief.feature}/product-state.json`, "{}\n");
    for (const name of ["status", "next"])
      expect((await runJson(w.root, name)).envelope.error?.code).toBe("ARTIFACT_INVALID");
  });
});
