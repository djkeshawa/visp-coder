import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, it } from "vitest";
import { PROFILES } from "../../src/core/constants.js";
import { createServer } from "../../src/mcp/server.js";
import { GoldenProject, Recorder } from "./support/project.js";

/**
 * What an MCP host's model reads on every turn before calling anything: the server's
 * instructions, each tool's name, description and input schema, and the resources with
 * their contents, for each install profile, served by the real server over the protocol.
 */
let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it.each(PROFILES)("lists the %s server's instructions, tools and resources", async (profile) => {
  project = await GoldenProject.create();
  const feature = await project.startFeature();
  await project.cli("work");
  const run = new Recorder(project, `mcp-surface/${profile}`);
  const server = createServer(project.root, profile);
  const client = new Client({ name: "visp-golden", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run.save("instructions.txt", client.getInstructions() ?? "(no instructions)");
    const { tools } = await client.listTools();
    await run.save("tools.json", JSON.stringify(tools, null, 2));
    if (profile === "minimal") return;
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    await run.save("resources.json", JSON.stringify({ resources, resourceTemplates }, null, 2));
    const uris = [
      ...resources.map((resource) => resource.uri),
      ...resourceTemplates.map((template) => template.uriTemplate.replace("{id}", feature)),
    ];
    for (const uri of uris) {
      const read = await client.readResource({ uri });
      const name = uri.replace(/^[a-z]+:\/\//, "").replaceAll(/[^A-Za-z0-9.-]+/g, "-");
      await run.save(`resource-${name}.json`, JSON.stringify(read, null, 2));
    }
  } finally {
    await client.close();
    await server.close();
  }
});
