import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { independentSources } from "../../../../src/workflow/product/independent-sources.js";
import { runProductWork, updateProductBrief } from "../../../../src/workflow/product/index.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import { deliveredSourceEvidence } from "../../../../src/workflow/product/review-source-delivery.js";
import {
  independentReviewerContext,
  productReviewerContext,
} from "../../../../src/workflow/product/reviewer-handoff.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});

async function setup(
  files: Record<string, string | Uint8Array>,
  greenfield = false,
  beforeWork?: (
    workspace: Awaited<ReturnType<typeof productWorkspace>>["workspace"],
  ) => Promise<void>,
) {
  const p = await productWorkspace();
  projects.push(p);
  if (greenfield) await rm(join(p.workspace.root, "src/value.mjs"));
  for (const [path, content] of Object.entries(files)) await p.workspace.write(path, content);
  p.workspace.commit("existing implementation");
  const updated = await updateProductBrief(await p.workspace.state(), {
    brief: {
      ...p.brief,
      slices: [{ ...p.brief.slices[0], scope: { allowed: ["**"], expected: [], forbidden: [] } }],
    },
    reason: "Review source changes across the existing application",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  await beforeWork?.(p.workspace);
  expect((await runProductWork(await p.workspace.state(), { task: "T001" })).ok).toBe(true);
  return p.workspace;
}

async function packet(w: Awaited<ReturnType<typeof setup>>) {
  const state = await w.state();
  const result = await runProductReview(state, { task: "T001" });
  if (!result.ok) throw new Error(result.error.message);
  const bundle = result.value;
  const sources = await independentSources(state, bundle.sources);
  if (!sources.ok) throw new Error(sources.error.message);
  return {
    ...independentReviewerContext(productReviewerContext(bundle)),
    sources: sources.value,
    evidence: deliveredSourceEvidence(bundle.evidence, bundle.sources, sources.value),
  };
}

async function preparedPacket(w: Awaited<ReturnType<typeof setup>>) {
  const prepared = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const session = prepared.value as { session: string; packetPath: string };
  const text = await readFile(session.packetPath, "utf8");
  return { session, text, packet: JSON.parse(text) };
}

it("delivers the small late hunk of a Django-sized file first and accepts its session citation", async () => {
  const query = `${"# Existing query implementation context\n".repeat(2488)}def combine_query():\n    lhs = 1\n    rhs = 2\n    return lhs + rhs\n`;
  const test = "def test_query():\n    assert combine_query() == 3\n";
  const w = await setup({
    "django/db/models/sql/query.py": query,
    "tests/queries/test_query.py": test,
  });
  await w.write("django/db/models/sql/query.py", query.replace("lhs + rhs", "lhs * rhs"));
  await w.write("tests/queries/test_query.py", test.replace("== 3", "== 2"));
  const diffModule = await import("../../../../src/workflow/product/review-diff.js");
  const legacy = vi.spyOn(diffModule, "reviewDiffSource").mockResolvedValue(undefined);
  const before = await preparedPacket(w);
  legacy.mockRestore();
  const exec = await import("../../../../src/core/exec.js");
  const calls = vi.spyOn(exec, "run");
  const shown = await packet(w);
  expect(
    calls.mock.calls.filter(([command, args]) => command === "git" && args.includes("diff")),
  ).toHaveLength(1);
  const diff = shown.sources.find((source) => source.kind === "implementation-diff");
  expect(diff).toBeDefined();
  expect(shown.sources.find((source) => source.kind.startsWith("implementation-"))).toBe(diff);
  expect(diff?.excerpt).toContain("def combine_query():");
  expect(diff?.excerpt).toContain("-    return lhs + rhs");
  expect(diff?.excerpt).toContain("+    return lhs * rhs");
  expect(diff?.excerpt).toContain("tests/queries/test_query.py");
  expect(shown.instructions).toContain("diff is the change under review");
  const { session, text, packet: saved } = await preparedPacket(w);
  expect(
    calls.mock.calls.filter(([command, args]) => command === "git" && args.includes("diff")),
  ).toHaveLength(2);
  console.info(
    `Django-like fixture: packet before=${before.text.length}, after=${text.length}; sources before=${JSON.stringify(before.packet.sources).length}, after=${JSON.stringify(saved.sources).length}`,
  );
  expect(JSON.stringify(saved.responseSchema)).toContain(diff?.id ?? "missing-diff");
  expect(saved.evidence).toContainEqual(
    expect.objectContaining({ id: diff?.id, kind: "source", status: "available" }),
  );
  expect(
    await runProductReviewRequest(await w.state(), {
      session: session.session,
      assessments: [
        {
          outcome: "O001",
          status: "unclear",
          summary: "Inspected the changed implementation",
          evidence: [diff?.id],
        },
      ],
    }),
  ).toMatchObject({ ok: true });
});

it("lists binary and non-UTF-8 changes without showing their bytes or agent scaffolding", async () => {
  const w = await setup({
    "assets/data.bin": Buffer.from([0, 1, 2]),
    "tests/latin1.sample": Buffer.from([0xe9]),
    ".agents/tool.py": "SECRET SCAFFOLD\n",
  });
  await w.write("assets/data.bin", Buffer.from([0, 3, 4]));
  await w.write("tests/latin1.sample", Buffer.from([0xe8]));
  await w.write(".agents/tool.py", "OTHER SECRET SCAFFOLD\n");
  const shown = await packet(w);
  const diff = shown.sources.find((source) => source.kind === "implementation-diff");
  expect(diff?.excerpt).toMatch(/assets\/data.bin.*binary.*not shown/i);
  expect(diff?.excerpt).toMatch(/tests\/latin1.sample.*UTF-8.*not shown/i);
  expect(diff?.excerpt).not.toContain(".agents");
});

it("splits a bounded diff fairly across files and names omitted hunk ranges", async () => {
  const paths = Array.from(
    { length: 24 },
    (_, index) => `src/file${String(index).padStart(2, "0")}.mjs`,
  );
  const before = `export function value() {\n${"  // original context\n".repeat(1200)}  return 1;\n}\n`;
  const w = await setup(Object.fromEntries(paths.map((path) => [path, before])));
  for (const path of paths)
    await w.write(
      path,
      before.replaceAll("original context", "new changed context").replace("return 1", "return 2"),
    );
  await w.write("src/new.mjs", "export const newValue = 3;\n");
  const shown = await packet(w);
  const diff = shown.sources.find((source) => source.kind === "implementation-diff");
  expect(diff).toBeDefined();
  expect(JSON.stringify(diff).length + 1).toBeLessThanOrEqual(12800);
  for (const path of paths) {
    const file = diff?.excerpt.split(/(?=^diff --git )/m).find((patch) => patch.includes(path));
    expect(file).toContain("-  // original context");
    expect(file).toContain("+  // new changed context");
  }
  expect(diff?.excerpt).toMatch(/Omitted hunks:.*old 1-1203.*new 1-1203/);
  expect(diff?.excerpt).not.toContain("src/new.mjs");
  expect(shown.sources.find((source) => source.reference === "src/new.mjs")?.excerpt).toBe(
    "export const newValue = 3;\n",
  );
  expect(JSON.stringify(shown.sources).length).toBeLessThanOrEqual(32000);
});

it("keeps greenfield packet bytes identical to delivery without a diff source", async () => {
  const w = await setup({}, true);
  await w.write("src/value.mjs", "export const value = 2;\n");
  const diffModule = await import("../../../../src/workflow/product/review-diff.js");
  const legacy = vi.spyOn(diffModule, "reviewDiffSource").mockResolvedValue(undefined);
  const before = (await preparedPacket(w)).text;
  legacy.mockRestore();
  expect((await preparedPacket(w)).text).toBe(before);
});

it("uses the saved authorization commit after HEAD advances and includes deleted files", async () => {
  const w = await setup({
    "src/module name.mjs": "export const value = 1;\n",
    "src/removed.mjs": "export const removed = 1;\n",
  });
  await w.write("src/module name.mjs", "export const value = 2;\n");
  w.commit("advance HEAD during slice");
  await w.write("src/module name.mjs", "export const value = 3;\n");
  await rm(join(w.root, "src/removed.mjs"));
  const shown = await packet(w);
  const diff = shown.sources.find((source) => source.kind === "implementation-diff");
  expect(diff?.excerpt).toContain("-export const value = 1;");
  expect(diff?.excerpt).toContain("+export const value = 3;");
  expect(diff?.excerpt).not.toContain("export const value = 2;");
  expect(diff?.excerpt).toContain("src/removed.mjs");
  expect(diff?.excerpt).toContain("+++ /dev/null");
});

it("discloses unrecoverable dirty baseline bytes instead of substituting HEAD", async () => {
  const w = await setup({}, false, async (workspace) =>
    workspace.write("src/value.mjs", "export const value = 3;\n"),
  );
  await w.write("src/value.mjs", "export const value = 4;\n");
  const shown = await packet(w);
  const diff = shown.sources.find((source) => source.kind === "implementation-diff");
  expect(diff?.excerpt).toContain(
    'Changed: "src/value.mjs"; baseline bytes unavailable; not shown.',
  );
  expect(diff?.excerpt).not.toContain("-export const value = 1;");
});

it.each([
  [
    "src/deep.py",
    "class Query:\n    def long_method(self):\n",
    "        value = 1\n",
    "        return value\n",
    "def long_method(self):",
  ],
  [
    "src/deep.js",
    "function outer() {\n  function longFunction() {\n",
    "    value += 1;\n",
    "    return value;\n  }\n}\n",
    "function longFunction() {",
  ],
])(
  "shows the enclosing definition for a deep edit in %s",
  async (path, header, body, footer, definition) => {
    const before = header + body.repeat(180) + footer;
    const w = await setup({ [path]: before });
    await w.write(
      path,
      header + body.repeat(160) + body.replace("1", "2") + body.repeat(19) + footer,
    );
    const diff = (await packet(w)).sources.find((source) => source.kind === "implementation-diff");
    expect(diff?.excerpt).toContain(definition);
    expect(diff?.excerpt).toContain(`+${body.replace("1", "2").trimEnd()}`);
    expect(JSON.stringify(diff).length + 1).toBeLessThanOrEqual(12800);
  },
);
it("does not treat a literal output-truncation marker in source as truncated Git output", async () => {
  const w = await setup({ "src/marker.mjs": 'export const marker = "original";\n' });
  await w.write("src/marker.mjs", 'export const marker = "[VISP: output truncated]";\n');
  const diff = (await packet(w)).sources.find((source) => source.kind === "implementation-diff");
  expect(diff?.excerpt).toContain('+export const marker = "[VISP: output truncated]";');
  expect(diff?.excerpt).not.toContain("hunks not shown");
});
