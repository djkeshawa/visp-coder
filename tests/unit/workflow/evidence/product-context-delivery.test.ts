import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import {
  type ProductWorkContext,
  runProductContext,
  runProductWork,
} from "../../../../src/workflow/product/work.js";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";
import { productWorkspace } from "../../support/product-workspace.js";

/**
 * Re-authorizing an unchanged slice repeated the whole context pack (source excerpts, graph,
 * memory, skills) to a worker that already had it from the same session. Only what changed
 * since this session's last delivery is sent again; a new session, an unknown session and
 * `--inspect` always get the full pack, and the reply says how to read what was left out.
 */
let setup: Awaited<ReturnType<typeof productWorkspace>>;

beforeEach(async () => {
  setup = await productWorkspace();
  vi.stubEnv("CODEX_THREAD_ID", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await setup.workspace.destroy();
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function hostSession(session: string): Promise<void> {
  const directory = join(setup.workspace.root, ".visp/session");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "host-session.json"), JSON.stringify({ session }));
}

const work = async (options: { deliverySession?: string } = {}) =>
  value(await runProductWork(await setup.workspace.state(), { task: "T001", ...options }));

function pack(context: ProductWorkContext) {
  return { files: context.files.length, graph: context.graph.length };
}

it("sends a host session only what changed since its last work reply", async () => {
  await hostSession("session-1");
  const first = await work();
  expect(first.files.length).toBeGreaterThan(0);
  expect(first.graph.length).toBeGreaterThan(0);
  expect(first.delivery).toBeUndefined();

  const again = await work();
  expect(pack(again)).toEqual({ files: 0, graph: 0 });
  expect(again.delivery?.unchanged).toEqual(expect.arrayContaining(["files", "graph"]));
  // Never trimmed: the request, outcomes, scope and current findings stay in every reply.
  expect(again.originalRequest).toBe(first.originalRequest);
  expect(again.outcomes).toEqual(first.outcomes);
  expect(again.scope).toEqual(first.scope);
  expect(again.feedbackPlan).toEqual(first.feedbackPlan);
  expect(again.budget.estimatedTokens).toBeLessThan(first.budget.estimatedTokens);
  const text = compactProductReply("work", again, "cli") ?? "";
  expect(text).toContain(
    "Not repeated (unchanged since this session's last work reply): files, graph",
  );
  expect(text).toContain("visp work --inspect --feature");

  // A changed source excerpt is sent again; the unchanged graph is not.
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const changed = await work();
  expect(changed.files.length).toBeGreaterThan(0);

  // Reading the context never reduces it.
  const inspected = value(await runProductContext(await setup.workspace.state(), { task: "T001" }));
  expect(inspected.files.length).toBeGreaterThan(0);
  expect(inspected.graph.length).toBeGreaterThan(0);
  expect(inspected.delivery).toBeUndefined();
});

it("sends the full pack to a new session and when no session is known", async () => {
  await work();
  expect(pack(await work())).toEqual(pack(await work()));
  expect((await work()).delivery).toBeUndefined();

  await hostSession("session-1");
  await work();
  await hostSession("session-2");
  const other = await work();
  expect(other.files.length).toBeGreaterThan(0);
  expect(other.delivery).toBeUndefined();
});

it("keys MCP deliveries to the server process the host started", async () => {
  await hostSession("session-1");
  await work({ deliverySession: "mcp:1" });
  const again = await work({ deliverySession: "mcp:1" });
  expect(again.delivery?.unchanged).toEqual(expect.arrayContaining(["files", "graph"]));
  expect(compactProductReply("visp_work", again, "mcp")).toContain(
    'visp_work {"feature":"001-return-two-from-the-public","task":"T001","inspect":true}',
  );
  const restarted = await work({ deliverySession: "mcp:2" });
  expect(restarted.files.length).toBeGreaterThan(0);
});
