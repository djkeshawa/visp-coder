import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import type { ProductWorkContext } from "../../../src/workflow/product/context-types.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());

it("surfaces malformed skill indexes across fresh CLI and MCP contexts without repairing or admitting them", async () => {
  const created = await productProject();
  project = created.project;
  await project.write(
    "candidate.md",
    "---\nname: context-boundary\nappliesTo:\n  paths: [src/**]\n---\n\n## Procedure\nCheck the public value before closing.\n",
  );
  succeeded(
    project,
    "skill",
    "propose",
    "--id",
    "context-boundary",
    "--file",
    "candidate.md",
    "--origin",
    "seeded",
  );
  succeeded(project, "skill", "admit", "context-boundary", "--by", "fixture-reviewer");
  const baseline = project.json<ProductWorkContext>("work", "--inspect");
  expect(baseline.result.exitCode, baseline.result.stdout).toBe(0);
  expect(baseline.envelope.data?.skills).toHaveLength(1);
  const indexPath = ".visp/skills/skills.json";
  const original = await project.read(indexPath);
  const statePath = `.visp/features/${created.feature}/product-state.json`;
  const originalState = await project.read(statePath);
  const client = new Client({ name: "skill-index-boundary", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "--project", project.root, "serve", "--mcp"],
    env: Object.fromEntries(
      Object.entries(project.env()).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    for (const malformed of [
      "{unfinished",
      JSON.stringify({ kind: "skills", skills: "not-an-array" }),
    ]) {
      await project.write(indexPath, malformed);
      for (const args of [["--inspect"], []]) {
        const result = project.json("work", ...args);
        expect(result.result.exitCode).not.toBe(0);
        expect(result.envelope).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
        expect(result.envelope).not.toHaveProperty("data");
      }
      for (const inspect of [true, false])
        for (const detail of [true, false]) {
          const response = await client.callTool({
            name: "visp_work",
            arguments: { inspect, detail },
          });
          expect(response.isError).toBe(true);
          expect(response.structuredContent).toMatchObject({
            ok: false,
            error: { code: "ARTIFACT_INVALID" },
          });
          expect(response.structuredContent).not.toHaveProperty("data");
        }
      expect(await project.read(indexPath)).toBe(malformed);
      expect(await project.read(statePath)).toBe(originalState);
    }
    await project.write(indexPath, original);
    const restored = project.json<ProductWorkContext>("work", "--inspect");
    expect(restored.result.exitCode, restored.result.stdout).toBe(0);
    expect(restored.envelope.data?.skills).toEqual(baseline.envelope.data?.skills);
    expect(restored.envelope.data?.scope).toEqual(baseline.envelope.data?.scope);
    const response = await client.callTool({
      name: "visp_work",
      arguments: { inspect: true, detail: true },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: true,
      data: { skills: baseline.envelope.data?.skills },
    });
  } finally {
    await client.close();
  }
});
