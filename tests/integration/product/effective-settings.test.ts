import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { explainSettings } from "../../../src/config/effective.js";
import { createServer } from "../../../src/mcp/server.js";
import { runJson } from "../../unit/cli/support/cli.js";
import { TestWorkspace } from "../../unit/support/workspace.js";

let project: TestWorkspace | undefined;
afterEach(async () => project?.destroy());

it("delivers identical requested settings through CLI and MCP without requiring a model", async () => {
  project = await TestWorkspace.create();
  await project.write(
    "visp.yml",
    "harness: generic\ncontext:\n  maxSnippets: 7\ncritic:\n  enabled: false\n",
  );
  const expected = await explainSettings(await project.state());
  const cli = await runJson<{ settings: unknown }>(project.root, "doctor", "--settings");
  expect(cli.envelope.data?.settings).toEqual(expected);
  const ordinary = await runJson(project.root, "doctor");
  expect(ordinary.envelope.data).not.toHaveProperty("settings");
  const server = createServer(project.root);
  const client = new Client({ name: "effective-settings-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const result = await client.callTool({ name: "visp_doctor", arguments: { settings: true } });
    expect(result.structuredContent).toMatchObject({ data: { settings: expected } });
    expect(JSON.stringify(result.content)).toContain("workflow.flipCheck");
    expect(JSON.stringify(result.content)).toContain("historical telemetry");
    expect(JSON.stringify(result.content)).toContain("context.maxSnippets");
  } finally {
    await client.close();
    await server.close();
  }
});
