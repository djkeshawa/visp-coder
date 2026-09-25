import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { RESOURCE } from "../../../src/mcp/constants.js";
import { createServer } from "../../../src/mcp/server.js";
import { type ProductBrief, parseProductBrief } from "../../../src/workflow/product/model.js";
import { runJson } from "../cli/support/cli.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
});

describe("authored brief identifier allocation", () => {
  it("accepts omitted IDs through the real MCP validator and produces the same brief as CLI input", async () => {
    workspace = await TestWorkspace.create();
    await workspace.installFoundation();
    workspace.commit("foundation");
    const created = await runJson<{ brief: ProductBrief }>(
      workspace.root,
      "feature",
      "Return a public value",
    );
    const brief = created.envelope.data?.brief;
    if (!brief) throw new Error(JSON.stringify(created.envelope));
    const authored = {
      ...brief,
      outcomes: [
        {
          kind: "functional",
          statement: "The value is two",
          expectations: [{ statement: "Reading the value returns two" }],
        },
      ],
      examples: [
        {
          title: "Read value",
          when: "Read the public module",
          expected: ["Two"],
          outcomes: ["O001"],
        },
      ],
      decisions: [{ statement: "Keep a public module", outcomes: ["O001"] }],
      checks: [{ command: [process.execPath, "-e", "process.exit(0)"], outcomes: ["O001"] }],
      slices: [
        {
          goal: "Public value",
          taskClass: "feature",
          outcomes: ["O001"],
          checks: ["C001"],
          scope: { allowed: ["value.js"] },
        },
      ],
    };
    const server = createServer(workspace.root);
    const client = new Client({ name: "brief-allocation-test", version: "1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = (await client.callTool({
        name: "visp_brief",
        arguments: { brief: authored },
      })) as CallToolResult;
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const returned = (response.structuredContent as { data: ProductBrief }).data;
      expect(returned.outcomes[0]?.id).toBe("O001");
      expect(returned.outcomes[0]?.expectations[0]?.id).toBe("O001_AC1");
      expect(returned.examples[0]?.id).toBe("SCN001");
      expect(returned.decisions[0]?.id).toBe("D001");
      expect(returned.checks[0]?.id).toBe("C001");
      expect(returned.slices[0]?.id).toBe("T001");
      expect(returned.slices[0]?.taskClass).toBe("feature");
      await workspace.write(".visp/authored-input.json", JSON.stringify(authored));
      const cli = await runJson<ProductBrief>(
        workspace.root,
        "brief",
        "--from",
        ".visp/authored-input.json",
      );
      expect(cli.exitCode, JSON.stringify(cli.envelope)).toBe(0);
      expect(cli.envelope.data).toEqual(returned);
      const state = await workspace.state();
      const statePath = `.visp/features/${brief.feature}/product-state.json`;
      const beforeRead = await state.files.readText(statePath);
      const status = (await client.callTool({
        name: "visp_status",
        arguments: {},
      })) as CallToolResult;
      const detailed = (await client.callTool({
        name: "visp_status",
        arguments: { detail: true },
      })) as CallToolResult;
      const resource = await client.readResource({ uri: RESOURCE.status });
      const resourceText = resource.contents[0];
      if (!resourceText || !("text" in resourceText))
        throw new Error("Status resource did not return text");
      const compact = JSON.parse(resourceText.text);
      expect(compact).toEqual((status.structuredContent as { data: unknown }).data);
      expect(compact).not.toHaveProperty("state");
      expect(compact).not.toHaveProperty("brief");
      expect((detailed.structuredContent as { data: unknown }).data).toHaveProperty("state");
      expect((detailed.structuredContent as { data: unknown }).data).toHaveProperty("brief");
      expect(await state.files.readText(statePath)).toEqual(beforeRead);
      const invalid = (await client.callTool({
        name: "visp_brief",
        arguments: {
          brief: { ...authored, outcomes: [{ ...authored.outcomes[0], id: "../invalid" }] },
        },
      })) as CallToolResult;
      expect(invalid.isError).toBe(true);
      const unresolved = (await client.callTool({
        name: "visp_brief",
        arguments: {
          brief: { ...authored, checks: [{ ...authored.checks[0], outcomes: ["O999"] }] },
        },
      })) as CallToolResult;
      expect(unresolved.isError).toBe(true);
      expect(JSON.stringify(unresolved)).toContain("unknown outcome O999");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reserves supplied expectation IDs and rejects ambiguous duplicate or malformed expectations", () => {
    const base = {
      version: 2,
      feature: "001-value",
      originalRequest: "Return value",
      goal: "Return value",
    };
    const outcome = {
      kind: "functional",
      statement: "The value is two",
      expectations: [
        { statement: "New promise" },
        { id: "O001_AC1", statement: "Existing promise" },
      ],
    };
    const parsed = parseProductBrief({ ...base, outcomes: [outcome] });
    expect(parsed.ok && parsed.value.outcomes[0]?.expectations.map((entry) => entry.id)).toEqual([
      "O001_AC2",
      "O001_AC1",
    ]);
    const duplicate = parseProductBrief({
      ...base,
      outcomes: [
        {
          ...outcome,
          expectations: outcome.expectations.map((entry) => ({ ...entry, id: "E001" })),
        },
      ],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: {
        code: "ARTIFACT_INVALID",
        message: expect.stringContaining("Duplicate expectation id E001"),
      },
    });
    expect(
      parseProductBrief({ ...base, outcomes: [{ ...outcome, expectations: [null] }] }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  });
});
