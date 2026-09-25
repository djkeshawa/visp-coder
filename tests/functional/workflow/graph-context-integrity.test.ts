import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import type { ProductWorkContext } from "../../../src/workflow/product/context-types.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

const projects: TestProject[] = [];
afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.destroy()));
});

it.each(["malformed", "foreign"] as const)(
  "withholds a %s graph across CLI and MCP inspection without rewriting it or granting scope",
  async (kind) => {
    const { project, feature } = await productProject();
    projects.push(project);
    succeeded(project, "work");
    const graphPath = resolve(project.root, ".visp/graph/graph.db");
    const original = await readFile(graphPath);
    const before = project.json<ProductWorkContext>("work", "--inspect").envelope.data;
    expect(before?.graph.length).toBeGreaterThan(0);
    let invalid = Buffer.from("This is not a graph database.\n");
    if (kind === "foreign") {
      const donor = (await productProject()).project;
      projects.push(donor);
      succeeded(donor, "work");
      invalid = await readFile(resolve(donor.root, ".visp/graph/graph.db"));
    }
    await writeFile(graphPath, invalid);
    const client = new Client({ name: "graph-integrity", version: "1" });
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
      const cli = project.json<ProductWorkContext>("work", "--inspect");
      expect(cli.result.exitCode, cli.result.stdout).toBe(0);
      assertUnavailable(cli.envelope.data, before, kind);
      for (const detail of [false, true]) {
        const response = await client.callTool({
          name: "visp_work",
          arguments: { feature, inspect: true, detail },
        });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        assertUnavailable(
          (response.structuredContent as { data: ProductWorkContext }).data,
          before,
          kind,
        );
      }
      expect(await readFile(graphPath)).toEqual(invalid);
      if (kind === "foreign") {
        succeeded(project, "index", "--refresh");
        const refreshed = project.json<ProductWorkContext>("work", "--inspect");
        expect(refreshed.result.exitCode, refreshed.result.stdout).toBe(0);
        expect(refreshed.envelope.data?.graph.length).toBeGreaterThan(0);
        expect(refreshed.envelope.data?.notes.join(" ")).not.toContain("another checkout");
        expect(refreshed.envelope.data?.scope).toEqual(before?.scope);
      }
      await writeFile(graphPath, original);
      const recovered = await client.callTool({
        name: "visp_work",
        arguments: { feature, inspect: true },
      });
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true);
      const context = (recovered.structuredContent as { data: ProductWorkContext }).data;
      expect(context.graph).toEqual(before?.graph);
      expect(context.scope).toEqual(before?.scope);
      expect(context.mayEdit).toBe(before?.mayEdit);
    } finally {
      await client.close();
    }
  },
);

function assertUnavailable(
  context: ProductWorkContext | undefined,
  before: ProductWorkContext | undefined,
  kind: "malformed" | "foreign",
) {
  expect(context?.graph).toEqual([]);
  expect(context?.notes.join(" ")).toContain("Graph unavailable:");
  if (kind === "foreign") expect(context?.notes.join(" ")).toContain("another checkout");
  expect(context?.scope).toEqual(before?.scope);
  expect(context?.mayEdit).toBe(before?.mayEdit);
}
