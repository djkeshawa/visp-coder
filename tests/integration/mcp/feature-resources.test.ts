import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESOURCE } from "../../../src/mcp/constants.js";
import { startProductProject } from "./resource-fixture.js";

describe("the authored brief resource", () => {
  let project: Awaited<ReturnType<typeof startProductProject>>;
  beforeAll(async () => {
    project = await startProductProject();
  });
  afterAll(async () => {
    await project.close();
  });
  it("returns the validated brief as read-only JSON with preserved request and expectations", async () => {
    const directory = join(project.root, ".visp/features", project.brief.feature);
    const before = await Promise.all(
      ["brief.yaml", "product-state.json"].map((file) => readFile(join(directory, file), "utf8")),
    );
    const uri = `visp://feature/${project.brief.feature}/brief`;
    const read = await project.read(uri);
    expect(read).toEqual({ uri, mimeType: "application/json", value: project.brief });
    expect(
      await Promise.all(
        ["brief.yaml", "product-state.json"].map((file) => readFile(join(directory, file), "utf8")),
      ),
    ).toEqual(before);
  });

  it("advertises the brief as the only per-feature template", async () => {
    const { resourceTemplates } = await project.client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([RESOURCE.brief]);
    for (const artifact of ["spec", "plan", "tasks"])
      await expect(
        project.read(`visp://feature/${project.brief.feature}/${artifact}`),
      ).rejects.toThrow(/not found/i);
    await expect(project.read("visp://context/T001")).rejects.toThrow(/not found/i);
  });
});
