import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { balancedCritic } from "../../../src/config/critic.js";
import { GUARD_PROTOCOL_VERSION } from "../../../src/core/constants.js";
import { applyFileTransaction } from "../../../src/core/file-transaction.js";
import type { Result } from "../../../src/core/result.js";
import { registerScopeTools } from "../../../src/mcp/tools/scope.js";
import { runProductCritic } from "../../../src/workflow/product/critic.js";
import { runProductVerify } from "../../../src/workflow/product/index.js";
import { runProductWork } from "../../../src/workflow/product/work.js";
import { runJson } from "../cli/support/cli.js";
import { productWorkspace } from "../support/product-workspace.js";

/**
 * `visp guard --path` (what the edit hook asks) and the MCP `visp_guard` tool must give the
 * same decision for the same question: the MCP docstring promises it, and an agent that
 * checks through MCP before writing must not be refused later by the hook, or the reverse.
 */
const criticModel = balancedCritic("codex")?.model;
let setup: Awaited<ReturnType<typeof productWorkspace>>;

beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
});

afterEach(async () => {
  await setup.workspace.destroy();
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function mcpGuard(paths: string[]): Promise<CallToolResult> {
  let handler: ((args: { paths: string[] }) => Promise<CallToolResult>) | undefined;
  registerScopeTools(
    {
      registerTool: (_name: string, _config: unknown, callback: unknown) => {
        handler = callback as typeof handler;
        return {};
      },
    } as unknown as McpServer,
    setup.workspace.root,
  );
  if (!handler) throw new Error("visp_guard was not registered");
  return handler({ paths });
}

/** Both surfaces' structured answers to the same question. */
async function bothSurfaces(paths: string[]) {
  const cli = await runJson<Record<string, unknown>>(
    setup.workspace.root,
    "guard",
    ...paths.flatMap((path) => ["--path", path]),
  );
  const mcp = await mcpGuard(paths);
  return {
    cli: cli.envelope.data,
    mcp: (mcp.structuredContent as { data?: Record<string, unknown> } | undefined)?.data,
  };
}

async function hostSession(session: string): Promise<void> {
  const directory = join(setup.workspace.root, ".visp/session");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "host-session.json"), JSON.stringify({ session }));
}

async function authorize(): Promise<void> {
  value(await runProductWork(await setup.workspace.state(), { task: "T001" }));
}

async function pendingReview(): Promise<void> {
  const critic = (input: object) =>
    setup.workspace.state().then((state) => runProductCritic(state, input));
  value(await critic({ operation: "set-policy", enabled: true, harness: "codex" }));
  await authorize();
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  value(await runProductVerify(await setup.workspace.state(), { task: "T001" }));
  value(
    await critic({
      operation: "prepare",
      task: "T001",
      capabilities: {
        harness: "codex",
        model: criticModel,
        reasoningEffort: "high",
        freshContext: true,
        images: true,
        readOnly: true,
        delegationAllowed: true,
      },
    }),
  );
}

describe("CLI and MCP guard parity", () => {
  it.each<[string, () => Promise<void>, string[], Record<string, unknown>]>([
    [
      "no slice authorized",
      async () => undefined,
      ["src/value.mjs"],
      { allowed: false, violations: [expect.objectContaining({ reason: "no-authorization" })] },
    ],
    ["an in-scope write", authorize, ["src/value.mjs"], { allowed: true, violations: [] }],
    [
      "an out-of-scope write",
      authorize,
      ["src/value.mjs", "src/other.mjs"],
      {
        allowed: false,
        violations: [expect.objectContaining({ reason: "outside-allowed-files" })],
      },
    ],
    [
      "a blocked path",
      authorize,
      [".env"],
      { allowed: false, violations: [expect.objectContaining({ reason: "blocked-path" })] },
    ],
    [
      "a pending independent review",
      pendingReview,
      ["src/value.mjs"],
      { allowed: false, violations: [expect.objectContaining({ reason: "review-pending" })] },
    ],
    [
      "an authorization from another host session",
      async () => {
        await hostSession("session-1");
        await authorize();
        await hostSession("session-2");
      },
      ["src/value.mjs"],
      {
        allowed: false,
        violations: [
          expect.objectContaining({ message: expect.stringContaining("earlier session") }),
        ],
      },
    ],
    [
      "an interrupted VISP update",
      async () => {
        await authorize();
        const interrupted = await applyFileTransaction(
          setup.workspace.root,
          "interrupted-update",
          [{ kind: "write", path: "src/value.mjs", content: "export const value = 3;\n" }],
          {
            afterMutation() {
              throw new Error("simulated process exit");
            },
            leavePreparedOnError: true,
          },
        );
        expect(interrupted.ok).toBe(false);
      },
      ["src/value.mjs"],
      {
        checked: 0,
        allowed: false,
        violations: [expect.objectContaining({ reason: "transaction-pending" })],
        transactions: [expect.any(String)],
      },
    ],
  ])("gives the same answer for %s", async (_name, arrange, paths, expected) => {
    await arrange();
    const { cli, mcp } = await bothSurfaces(paths);
    expect(cli).toMatchObject({ protocolVersion: GUARD_PROTOCOL_VERSION, ...expected });
    expect(mcp).toEqual(cli);
  });
});
