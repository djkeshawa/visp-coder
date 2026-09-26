import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINIMAL_TOOLS, RESOURCE, TOOL } from "../../../src/mcp/constants.js";
import { createServer } from "../../../src/mcp/server.js";
import { runInit } from "../../../src/workflow/stages/init.js";

let root: string;
let client: Client;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-mcp-integration-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  const init = await runInit({ root, harness: "generic" });
  expect(init.ok).toBe(true);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "visp-test-client", version: "0.0.0" });

  await Promise.all([createServer(root).connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await rm(root, { recursive: true, force: true });
});

interface Envelope {
  readonly tool: string;
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { code: string; recovery?: string };
  readonly nextCommand?: string;
}

/** structuredContent, narrowed for assertions. */
function structured(result: unknown): Envelope {
  const payload = (result as { structuredContent?: unknown }).structuredContent;
  expect(payload).toBeDefined();
  return payload as Envelope;
}

/** The first resource content block, which is always text for visp:// URIs. */
function firstContent(contents: readonly unknown[]): { text?: string; mimeType?: string } {
  return (contents[0] ?? {}) as { text?: string; mimeType?: string };
}

describe("tool listing", () => {
  it("advertises every visp tool", async () => {
    const { tools } = await client.listTools();
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.values(TOOL).sort());
  });

  it("gives every tool an object input schema", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema.type, `${tool.name} input schema`).toBe("object");
      expect(tool.description, `${tool.name} description`).toBeTruthy();
    }
  });

  it("advertises exact feature enums to guide model tool calls", async () => {
    const { tools } = await client.listTools();
    const feature = tools.find((tool) => tool.name === TOOL.feature);
    const properties = feature?.inputSchema.properties as
      | Record<string, { enum?: unknown }>
      | undefined;

    expect(properties?.riskLevel?.enum).toEqual(["low", "medium", "high", "critical"]);
    expect(properties?.workflow?.enum).toEqual(["full", "compact"]);
  });
});

describe("the minimal profile's surface", () => {
  it("advertises exactly the minimal tool set, and no resources", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const minimalClient = new Client({ name: "visp-test-client", version: "0.0.0" });
    await Promise.all([
      createServer(root, "minimal").connect(serverTransport),
      minimalClient.connect(clientTransport),
    ]);

    try {
      const { tools } = await minimalClient.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...MINIMAL_TOOLS].sort());
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "visp_next",
          "visp_feature",
          "visp_brief",
          "visp_work",
          "visp_done",
          "visp_accept",
          "visp_review",
          "visp_observations",
          "visp_capture",
          "visp_query",
          "visp_guard",
        ]),
      );

      // No resources registered means the capability is not offered at all.
      await expect(minimalClient.listResources()).rejects.toThrow();
    } finally {
      await minimalClient.close();
    }
  });
});

describe("visp_status", () => {
  it("reports a freshly initialized project as having no feature", async () => {
    const result = await client.callTool({ name: TOOL.status, arguments: {} });
    const payload = structured(result);

    expect(result.isError).toBeFalsy();
    expect(payload.ok).toBe(true);
    expect(payload.data?.feature).toBeUndefined();
    expect(payload.data?.outcomes).toEqual([]);
    expect(payload.data?.next).toMatchObject({
      action: "understand",
      mayEdit: false,
      command: 'visp feature "<goal>"',
    });
  });
});

describe("visp_guard", () => {
  it("refuses a project-wide blocked path", async () => {
    const result = await client.callTool({ name: TOOL.guard, arguments: { paths: [".env"] } });
    const payload = structured(result);

    // A refusal is an answer, not a tool failure.
    expect(result.isError).toBeFalsy();
    expect(payload.data?.allowed).toBe(false);

    const violations = payload.data?.violations as { path: string; reason: string }[];
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe(".env");
    expect(violations[0]?.reason).toBe("blocked-path");
  });

  it("rejects arguments that do not match the schema", async () => {
    const result = await client.callTool({ name: TOOL.guard, arguments: { paths: [] } });
    expect(result.isError).toBe(true);
  });
});

describe("resources", () => {
  it("lists the static visp:// resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((resource) => resource.uri);

    expect(uris).toContain(RESOURCE.status);
    expect(uris).toContain(RESOURCE.policy);
    expect(uris).toContain(RESOURCE.scope);
  });

  it("serves the scope resource as JSON", async () => {
    const { contents } = await client.readResource({ uri: RESOURCE.scope });
    const entry = firstContent(contents);

    expect(entry.mimeType).toBe("application/json");
    const parsed = JSON.parse(String(entry.text)) as {
      authorized: unknown[];
      blockedPaths: string[];
    };
    expect(parsed.authorized).toEqual([]);
    expect(parsed.blockedPaths).toContain(".env");
  });

  it("serves the policy resource with the active rules and strictness", async () => {
    const { contents } = await client.readResource({ uri: RESOURCE.policy });
    const parsed = JSON.parse(String(firstContent(contents).text)) as {
      strictness: string;
      activeRules: { id: string }[];
    };

    expect(parsed.strictness).toBe("standard");
    expect(parsed.activeRules.length).toBeGreaterThan(0);
  });
});

describe("error mapping over the wire", () => {
  it("turns a missing feature into an isError result with a recovery command", async () => {
    const result = await client.callTool({ name: TOOL.brief, arguments: {} });
    const payload = structured(result);

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("NO_ACTIVE_FEATURE");
    expect(payload.error?.recovery).toBeTruthy();
  });

  it("rejects a malformed artifact identifier before the handler runs", async () => {
    const task = await client.callTool({
      name: TOOL.work,
      arguments: { task: "../../T001" },
    });

    expect(task.isError).toBe(true);
    expect(task.content).toEqual(
      expect.arrayContaining([{ type: "text", text: expect.stringContaining("task") }]),
    );
  });

  it.each([
    ["riskLevel", "catastrophic"],
    ["workflow", "magic"],
  ])("rejects an unknown feature %s in the advertised schema", async (field, value) => {
    const result = await client.callTool({
      name: TOOL.feature,
      arguments: { goal: "typed boundary", [field]: value },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([{ type: "text", text: expect.stringContaining(field) }]),
    );
  });
});

describe("visp_doctor", () => {
  it("reports the setup, so a refusal can be told from a broken install", async () => {
    const result = await client.callTool({ name: TOOL.doctor, arguments: {} });
    const envelope = structured(result);

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.verdict).toBeTruthy();
    expect(Array.isArray(envelope.data?.checks)).toBe(true);
  });
});
