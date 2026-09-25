import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../../src/mcp/server.js";
import { readSession } from "../../../src/orchestrate/session.js";
import { runInit } from "../../../src/workflow/stages/init.js";
import { loadWorkspace } from "../../../src/workflow/state.js";

/**
 * The graph tools are how an MCP-connected agent finds the blast radius of a
 * change without reading its way there.
 */
describe("graph tools over MCP", () => {
  let root = "";
  let client: Client;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "visp-mcp-graph-"));

    await write(root, "src/token.ts", "export function makeToken(u: string) {\n  return u;\n}\n");
    await write(
      root,
      "src/login.ts",
      'import { makeToken } from "./token.js";\nexport function login(u: string) {\n  return makeToken(u);\n}\n',
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    await runInit({ root, harness: "generic" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });

    await Promise.all([
      client.connect(clientTransport),
      createServer(root).connect(serverTransport),
    ]);
  });

  afterAll(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    return (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: { ok: boolean; data?: unknown; error?: { code: string } };
    };
  }

  it("advertises the query and index tools", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("visp_query");
    expect(names).toContain("visp_index");
  });

  it("says the repository is not indexed rather than returning nothing", async () => {
    const result = await call("visp_query", { operation: "describe" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.code).toBe("GRAPH_MISSING");
  });

  it("indexes the repository", async () => {
    const result = await call("visp_index", {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("entities");
  });

  it("answers a structural question with rows and structured content", async () => {
    const result = await call("visp_query", { operation: "search", target: "makeToken" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("src/token.ts");

    const data = result.structuredContent?.data as { rows: unknown[] };
    expect(data.rows.length).toBeGreaterThan(0);
  });

  it("finds what would break if a symbol changed", async () => {
    const result = await call("visp_query", {
      operation: "impact",
      target: "src/token.ts",
    });
    expect(result.content[0]?.text).toContain("src/login.ts");
  });

  it("resolves named symbols like the CLI instead of silently returning no callers", async () => {
    const result = await call("visp_query", { operation: "callers", target: "makeToken" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("src/login.ts");
  });

  it("returns an actionable error for a whole file where one symbol is needed", async () => {
    const result = await call("visp_query", { operation: "callers", target: "src/token.ts" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error?.code).toBe("UNSUPPORTED");
    expect(result.content[0]?.text).toContain("needs one symbol");
  });

  it("passes request depth, result and traversal budgets through the tool boundary", async () => {
    const result = await call("visp_query", {
      operation: "neighbors",
      target: "makeToken",
      depth: 2,
      results: 3,
      nodes: 1,
      edges: 2,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.data).toMatchObject({
      receipt: {
        truncated: true,
        budget: { depth: 2, results: 3, nodes: 1, edges: 2 },
        work: { visitedNodes: 1 },
      },
    });
    expect(result.content[0]?.text).toContain("increase nodes or edges");
  });

  it("re-indexes without re-parsing when nothing changed", async () => {
    const result = await call("visp_index", { refresh: true });
    expect(result.content[0]?.text).toContain("Nothing changed");
  });

  it("can omit file lists without hiding index identity, coverage or skipped counts", async () => {
    const complete = await call("visp_index", { refresh: true });
    const compact = await call("visp_index", { refresh: true, detail: false });
    const full = complete.structuredContent?.data as {
      snapshotId: string;
      counts: unknown;
      diff: { unchanged: string[] };
      skipped: unknown[];
      languageCoverage: unknown;
    };
    expect(Array.isArray(full.diff.unchanged)).toBe(true);
    expect(compact.structuredContent?.data).toMatchObject({
      snapshotId: full.snapshotId,
      counts: full.counts,
      languageCoverage: full.languageCoverage,
      diff: { unchanged: full.diff.unchanged.length },
      skipped: { count: full.skipped.length },
      detail: expect.stringContaining("detail:true"),
    });
  });

  it("rejects an unknown operation at the schema boundary", async () => {
    const result = await call("visp_query", { operation: "not-an-operation" });
    expect(result.isError).toBe(true);
  });

  it("records successful MCP graph operations without counting refused queries", async () => {
    const state = await loadWorkspace(root);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const session = await readSession(state.value);
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const commands = session.value.activity.map((entry) => entry.command);
    expect(commands.filter((command) => command === "index")).toHaveLength(1);
    expect(commands.filter((command) => command === "index --refresh")).toHaveLength(3);
    expect(commands.filter((command) => command === "query")).toHaveLength(4);
    expect(session.value.activity.every((entry) => entry.outcome === "ok")).toBe(true);
  });
});

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}
