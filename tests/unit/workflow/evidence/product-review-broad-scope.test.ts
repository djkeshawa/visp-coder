import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import { sha256 } from "../../../../src/core/hash.js";
import { ok } from "../../../../src/core/result.js";
import { productEvidenceGaps } from "../../../../src/workflow/product/assessment.js";
import {
  CORE_SCOPE_FILE_LIMIT,
  coreReviewPaths,
} from "../../../../src/workflow/product/core-review-sources.js";
import { type CriticPacket, runProductCritic } from "../../../../src/workflow/product/critic.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import { productEvidenceCatalogue } from "../../../../src/workflow/product/evidence-references.js";
import { independentSources } from "../../../../src/workflow/product/independent-sources.js";
import {
  createProductFeature,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import type { ProductCheck } from "../../../../src/workflow/product/model.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { deliveredReviewEvidenceIds } from "../../../../src/workflow/product/review-context.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import {
  deliveredSources,
  REVIEW_SOURCE_BUDGET,
} from "../../../../src/workflow/product/review-source-delivery.js";
import type { ProductSource } from "../../../../src/workflow/product/sources.js";
import { type ProductRecord, readProductRecord } from "../../../../src/workflow/product/store.js";
import { productSourceDigest } from "../../../../src/workflow/product/subject.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { TestWorkspace } from "../../support/workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  for (const p of projects.splice(0)) await p.workspace.destroy();
});

/** An existing repository at its base commit, then a slice authorized with the given scope. */
async function setup(files: Record<string, string | Uint8Array>, allowed = ["**"]) {
  const p = await productWorkspace();
  projects.push(p);
  for (const [path, content] of Object.entries(files)) await p.workspace.write(path, content);
  p.workspace.commit("existing repository");
  const updated = await updateProductBrief(await p.workspace.state(), {
    brief: {
      ...p.brief,
      slices: [{ ...p.brief.slices[0], scope: { allowed, expected: [], forbidden: [] } }],
    },
    reason: "Fix one behavior in the existing repository",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  expect((await runProductWork(await p.workspace.state(), { task: "T001" })).ok).toBe(true);
  return p.workspace;
}

/** The same product, created from a request that names a document as an input. */
async function setupWithRequest(files: Record<string, string>, request: string) {
  const workspace = await TestWorkspace.create({
    "src/value.mjs": "export const value = 1;\n",
    "test/value.test.mjs":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('the promised value',()=>assert.equal(value,2));\n",
    ...files,
  });
  projects.push({ workspace, brief: undefined as never });
  await workspace.installFoundation();
  workspace.commit("existing repository");
  const started = await createProductFeature(await workspace.state(), {
    goal: "Return two from the public module",
    sourceBrief: request,
  });
  if (!started.ok) throw new Error(started.error.message);
  const updated = await updateProductBrief(await workspace.state(), {
    brief: {
      ...started.value.brief,
      outcomes: [
        {
          id: "O001",
          kind: "functional",
          statement: "The public value is two",
          priority: "must",
          provenance: "user-stated",
        },
      ],
      checks: [
        {
          id: "C001",
          command: [process.execPath, "--test", "test/value.test.mjs"],
          outcomes: ["O001"],
          files: ["src/value.mjs", "test/value.test.mjs"],
          environment: "node",
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Return the promised value",
          outcomes: ["O001"],
          scope: { allowed: ["**"], expected: [], forbidden: [] },
          checks: ["C001"],
        },
      ],
    },
    reason: "Define the first usable behavior",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  expect((await runProductWork(await workspace.state(), { task: "T001" })).ok).toBe(true);
  return workspace;
}

async function delivered(w: Awaited<ReturnType<typeof setup>>) {
  const state = await w.state();
  const review = await runProductReview(state, { task: "T001" });
  if (!review.ok) throw new Error(review.error.message);
  const sources = await independentSources(state, review.value.sources);
  if (!sources.ok) throw new Error(sources.error.message);
  return sources.value;
}

async function prepared(w: Awaited<ReturnType<typeof setup>>) {
  const result = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!result.ok) throw new Error(result.error.message);
  const { packetPath } = result.value as { packetPath: string };
  return JSON.parse(await readFile(packetPath, "utf8")) as { sources: ProductSource[] };
}

const binary = (seed: number) => Uint8Array.from([0xde, 0x12, 0x04, 0x95, 0, seed % 256, 0, 1]);
const pad = (index: number) => String(index).padStart(3, "0");

/** Django-like: many modules, compiled locale catalogues and a documentation tree. */
function repository(modules = 150, catalogues = 120) {
  const files: Record<string, string | Uint8Array> = {
    "pkg/forms.py": `from pkg.fields import CharField\nfrom pkg.widgets import TextInput\n\n${"# existing form machinery\n".repeat(2000)}class UsernameField(CharField):\n    def widget_attrs(self, widget):\n        return {}\n`,
    "pkg/fields.py": "class CharField:\n    max_length = None\n",
    "pkg/widgets.py": "class TextInput:\n    attrs = {}\n",
  };
  for (let index = 0; index < modules; index++)
    files[`pkg/module${pad(index)}.py`] = `def helper_${index}():\n    return ${index}\n`;
  for (let index = 0; index < catalogues; index++)
    files[`pkg/locale/l${pad(index)}/LC_MESSAGES/django.mo`] = binary(index);
  for (let index = 0; index < 30; index++) files[`docs/topic${pad(index)}/index.txt`] = "Topic\n";
  return files;
}

const core = (sources: readonly ProductSource[]) =>
  sources.filter((source) => source.coreOutcomes !== undefined && source.reference !== "");

it("prepares a review on a large existing repository with a broad scope instead of refusing it", async () => {
  const w = await setup(repository());
  const before = await readFile(`${w.root}/pkg/forms.py`, "utf8");
  await w.write(
    "pkg/forms.py",
    before.replace("return {}", "return {'maxlength': self.max_length}"),
  );
  const sources = await delivered(w);
  expect(JSON.stringify(sources).length).toBeLessThanOrEqual(REVIEW_SOURCE_BUDGET);
  // The change is core; unchanged in-scope files and binary catalogues are not.
  expect(core(sources).map((source) => source.reference)).toEqual(["pkg/forms.py"]);
  expect(sources.some((source) => source.reference.endsWith(".mo"))).toBe(false);
  expect(sources.some((source) => source.reference.startsWith("docs/"))).toBe(false);
  const scope = sources.find((source) => source.id === "CODE-SCOPE");
  expect(scope?.excerpt).toMatch(/covers \d+ project files.*core sources are the 1 files changed/);
  // Files the change imports are delivered as context, not as core.
  const context = sources.filter((source) =>
    ["pkg/fields.py", "pkg/widgets.py"].includes(source.reference),
  );
  expect(context).toHaveLength(2);
  expect(context.every((source) => source.coreOutcomes === undefined)).toBe(true);
  const diff = sources.find((source) => source.kind === "implementation-diff");
  expect(diff?.excerpt).toContain("+        return {'maxlength': self.max_length}");
  // A prepared review session carries the same selection.
  const packet = await prepared(w);
  expect(packet.sources.some((source) => source.id === "CODE-SCOPE")).toBe(true);
  expect(core(packet.sources).map((source) => source.reference)).toEqual(["pkg/forms.py"]);
});

it("summarizes many changed binary files instead of refusing the review", async () => {
  const w = await setup(repository(10, 120));
  for (let index = 0; index < 120; index++)
    await w.write(`pkg/locale/l${pad(index)}/LC_MESSAGES/django.mo`, binary(index + 7));
  await w.write("pkg/fields.py", "class CharField:\n    max_length = 150\n");
  const sources = await delivered(w);
  expect(JSON.stringify(sources).length).toBeLessThanOrEqual(REVIEW_SOURCE_BUDGET);
  const rest = sources.find((source) => source.id === "CODE-UNAVAILABLE-REST");
  expect(rest?.excerpt).toMatch(/^\d+ further sources are missing, binary or unreadable/);
  const named = sources.filter((source) => source.reference.endsWith(".mo"));
  expect(named.length).toBeGreaterThan(0);
  expect(named.length + Number(rest?.excerpt.match(/^\d+/)?.[0])).toBe(120);
  // Unavailable core files still limit the outcomes they map to.
  expect(sources.find((source) => source.id === "CODE-CORE-GAPS")?.excerpt).toContain("O001");
  expect(sources.find((source) => source.reference === "pkg/fields.py")?.excerpt).toContain(
    "max_length = 150",
  );
});

it("anchors core on the change when a narrow scope's imports reach most of the repository", async () => {
  const files: Record<string, string> = {
    "pkg/entry.py": "from pkg.chain000 import step\n\ndef run():\n    return step()\n",
  };
  for (let index = 0; index < CORE_SCOPE_FILE_LIMIT + 20; index++)
    files[`pkg/chain${pad(index)}.py`] =
      `from pkg.chain${pad(index + 1)} import step as next_step\n\ndef step():\n    return ${index}\n`;
  const w = await setup(files, ["pkg/entry.py"]);
  await w.write(
    "pkg/entry.py",
    files["pkg/entry.py"]?.replace("return step()", "return step() + 1") ?? "",
  );
  const sources = await delivered(w);
  expect(core(sources).map((source) => source.reference)).toEqual(["pkg/entry.py"]);
  expect(sources.find((source) => source.id === "CODE-SCOPE")?.excerpt).toContain(
    "covers 1 project files",
  );
  expect(sources.find((source) => source.reference === "pkg/chain000.py")?.coreOutcomes).toBe(
    undefined,
  );
});

it("keeps scope-based core for a project within the limit", async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 20; index++)
    files[`src/part${pad(index)}.mjs`] = `export const part${index} = ${index};\n`;
  const w = await setup(files);
  await w.write("src/value.mjs", "export const value = 2;\n");
  const sources = await delivered(w);
  expect(sources.some((source) => source.id === "CODE-SCOPE")).toBe(false);
  // Unchanged in-scope files stay core, exactly as before.
  expect(core(sources).map((source) => source.reference)).toEqual(
    expect.arrayContaining(["src/value.mjs", "src/part000.mjs", "src/part019.mjs"]),
  );
});

it("keeps a document the request names as context, not core, when the scope is broad", async () => {
  const files: Record<string, string> = { "docs/guide.txt": "Values are returned as integers.\n" };
  for (let index = 0; index < CORE_SCOPE_FILE_LIMIT + 10; index++)
    files[`lib/part${pad(index)}.mjs`] = `export const part${index} = ${index};\n`;
  const w = await setupWithRequest(
    files,
    "Read docs/guide.txt first, then make the public module return two.",
  );
  await w.write("src/value.mjs", "export const value = 2;\n");
  const sources = await delivered(w);
  expect(core(sources).map((source) => source.reference)).toEqual(["src/value.mjs"]);
  const guide = sources.find((source) => source.reference === "docs/guide.txt");
  expect(guide?.excerpt).toContain("returned as integers");
  expect(guide?.coreOutcomes).toBeUndefined();
});

it("accepts citations of the scope and unavailable-file summaries in a prepared session", async () => {
  const w = await setup(repository(10, 120));
  for (let index = 0; index < 120; index++)
    await w.write(`pkg/locale/l${pad(index)}/LC_MESSAGES/django.mo`, binary(index + 3));
  await w.write("pkg/fields.py", "class CharField:\n    max_length = 150\n");
  const result = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!result.ok) throw new Error(result.error.message);
  const session = result.value as { packetPath: string; session: string };
  const packet = JSON.parse(await readFile(session.packetPath, "utf8"));
  const ids = deliveredReviewEvidenceIds(
    packet.evidence,
    packet.interactionEvidence,
    packet.sources,
    packet.experiments,
  );
  expect(ids).toEqual(
    expect.arrayContaining(["CODE-SCOPE", "CODE-UNAVAILABLE-REST", "CODE-CORE-GAPS"]),
  );
  const submitted = await runProductReviewRequest(await w.state(), {
    session: session.session,
    assessments: [
      {
        outcome: "O001",
        status: "unclear",
        summary: "The changed catalogues are binary and were not shown",
        evidence: ids,
        expectations: [],
      },
    ],
  });
  expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
});

it("anchors closed-slice and whole-feature reviews on the retained baseline's changes", async () => {
  const w = await setup(repository(100, 20));
  await w.write("src/value.mjs", "export const value = 2;\n");
  const state = await w.state();
  expect(await runProductDone(state, { task: "T001" })).toMatchObject({
    ok: true,
    value: { closed: true },
  });
  for (const task of ["T001", undefined]) {
    const review = await runProductReview(state, { task });
    if (!review.ok) throw new Error(review.error.message);
    const sources = await independentSources(state, review.value.sources);
    if (!sources.ok) throw new Error(sources.error.message);
    expect(core(sources.value).map((source) => source.reference)).toEqual(["src/value.mjs"]);
    expect(sources.value.find((source) => source.id === "CODE-SCOPE")?.excerpt).toContain(
      "core sources are the 1 files changed",
    );
    expect(JSON.stringify(sources.value).length).toBeLessThanOrEqual(REVIEW_SOURCE_BUDGET);
  }
});

it("keeps delivered broad-scope citations valid at completion and after a later authorization", async () => {
  const p = await productWorkspace();
  projects.push(p);
  const w = p.workspace;
  for (let index = 0; index < 80; index++)
    await w.write(`src/module${pad(index)}.mjs`, `export const value${index} = ${index};\n`);
  w.commit("existing repository");
  const slice = { ...p.brief.slices[0], scope: { allowed: ["**"], expected: [], forbidden: [] } };
  const updated = await updateProductBrief(await w.state(), {
    brief: {
      ...p.brief,
      checks: [{ ...p.brief.checks[0], files: ["src/**", "test/**"] }],
      slices: [slice, { ...slice, id: "T002" }],
    },
    reason: "Review completion evidence in a broad scope",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await w.state(), { task: "T001" })).ok).toBe(true);
  const prepared = await runProductReviewRequest(await w.state(), { prepare: true, task: "T001" });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const session = prepared.value as { packetPath: string; session: string };
  const packet = JSON.parse(await readFile(session.packetPath, "utf8"));
  expect(packet.sources.some((source: ProductSource) => source.id === "CODE-SCOPE")).toBe(true);
  const source = packet.sources.find((entry: ProductSource) => entry.reference === "src/value.mjs");
  const execution = packet.evidence.find(
    (entry: { kind: string; status: string }) =>
      entry.kind === "execution" && entry.status === "available",
  );
  const submitted = await runProductReviewRequest(await w.state(), {
    session: session.session,
    assessments: [
      {
        outcome: "O001",
        status: "satisfied",
        summary: "The changed module returns two and its check passed",
        evidence: [source.id, execution.id],
        expectations: [],
      },
    ],
  });
  expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
  expect(await runProductDone(await w.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { closed: true },
  });
  // A later authorization moves the retained baseline; the recorded identity still resolves.
  expect((await runProductWork(await w.state(), { task: "T002" })).ok).toBe(true);
  const state = await w.state();
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const subject = await productSourceDigest(state);
  if (!subject.ok) throw new Error(subject.error.message);
  expect(
    await productEvidenceGaps(state, record.value, subject.value, record.value.brief.slices[0]),
  ).toEqual([]);
  // After the source changes, the recorded identity no longer counts as available evidence.
  await w.write("src/value.mjs", "export const value = 3;\n");
  const changed = await productSourceDigest(await w.state());
  if (!changed.ok) throw new Error(changed.error.message);
  const catalogue = await productEvidenceCatalogue(
    await w.state(),
    record.value,
    changed.value,
    [],
    [],
    undefined,
    record.value.brief.slices[0],
  );
  expect(catalogue.entries.find((entry) => entry.id === source.id)?.status).not.toBe("available");
});

it("lists deleted and renamed paths of a broad-scope change in its disclosure", async () => {
  const w = await setup(repository(80, 0));
  await rm(join(w.root, "pkg/module003.py"));
  await w.write("pkg/fields.py", "class CharField:\n    max_length = 150\n");
  const sources = await delivered(w);
  expect(core(sources).map((source) => source.reference)).toEqual(["pkg/fields.py"]);
  expect(sources.find((source) => source.id === "CODE-SCOPE")?.excerpt).toContain(
    "1 changed paths no longer exist (deleted or renamed); the change diff shows them: pkg/module003.py",
  );
  expect(sources.find((source) => source.kind === "implementation-diff")?.excerpt).toContain(
    "pkg/module003.py",
  );
});

const unavailable = (index: number, coreOutcomes = ["O001"]): ProductSource => ({
  id: `CODE-${pad(index)}`,
  kind: "implementation-file",
  reference: `pkg/locale/l${pad(index)}/LC_MESSAGES/django.mo`,
  sha256: sha256(String(index)),
  available: false,
  excerpt: "Source is missing or binary; inspect with an appropriate reader",
  truncated: true,
  coreOutcomes,
});

it("summarizes unavailable files only when the packet would otherwise be refused", async () => {
  const pinned: ProductSource = {
    id: "SRC-pinned",
    kind: "pinned-file",
    reference: "acceptance/spec.txt",
    sha256: sha256("baseline"),
    available: false,
    excerpt: "changed pinned content\n".repeat(90).slice(0, 2000),
  };
  // Fits as before: every unavailable file stays named, nothing is summarized.
  const few = await deliveredSources(
    [pinned, ...Array.from({ length: 20 }, (_, i) => unavailable(i))],
    new Map(),
  );
  expect(few.filter((source) => source.reference.endsWith(".mo"))).toHaveLength(20);
  expect(few.some((source) => source.id === "CODE-UNAVAILABLE-REST")).toBe(false);
  // Would be refused: binaries are summarized, the pinned acceptance identity is kept whole.
  const many = await deliveredSources(
    [pinned, ...Array.from({ length: 120 }, (_, i) => unavailable(i))],
    new Map(),
  );
  expect(many.find((source) => source.id === pinned.id)?.excerpt).toBe(pinned.excerpt);
  expect(many.some((source) => source.id === "CODE-UNAVAILABLE-REST")).toBe(true);
  expect(many.find((source) => source.id === "CODE-CORE-GAPS")?.excerpt).toContain("O001");
});

it("treats check inputs wider than one review as broad without reading each of them", async () => {
  const tests = Array.from({ length: 5000 }, (_, i) => `test/test${i}.py`);
  const snapshot = Object.fromEntries(["src/entry.py", ...tests].map((path) => [path, "x"]));
  const record = {
    brief: {
      outcomes: [{ id: "O001", priority: "must" }],
      slices: [{ outcomes: ["O001"], scope: { allowed: ["src/entry.py"], expected: [] } }],
    },
  } as unknown as ProductRecord;
  const check = {
    command: ["python", "-m", "pytest"],
    outcomes: ["O001"],
    files: [],
  } as unknown as ProductCheck;
  let reads = 0;
  const selected = await coreReviewPaths(
    { files: { readTextIfExists: async () => ok("") } } as unknown as WorkspaceState,
    record,
    snapshot,
    [{ check, paths: tests }],
    undefined,
    new Set(["src/entry.py"]),
    async () => {
      reads++;
      return ok("");
    },
  );
  expect(selected.broad).toBeDefined();
  expect([...selected.core.keys()]).toEqual(["src/entry.py"]);
  expect(reads).toBeLessThan(10);
});

it("treats many small checks of one outcome as wide inputs without reading them all", async () => {
  const tests = Array.from({ length: 512 }, (_, i) => `test/test${i}.py`);
  const snapshot = Object.fromEntries(
    ["pkg/entry.py", ...tests, ...tests.map((_, i) => `pkg/part${i}.py`)].map((path) => [
      path,
      "x",
    ]),
  );
  const record = {
    brief: {
      outcomes: [{ id: "O001", priority: "must" }],
      slices: [{ outcomes: ["O001"], scope: { allowed: ["pkg/entry.py"], expected: [] } }],
    },
  } as unknown as ProductRecord;
  let reads = 0;
  const selected = await coreReviewPaths(
    { files: { readTextIfExists: async () => ok("") } } as unknown as WorkspaceState,
    record,
    snapshot,
    tests.map((path) => ({
      check: { outcomes: ["O001"] } as unknown as ProductCheck,
      paths: [path],
    })),
    undefined,
    new Set(["pkg/entry.py"]),
    async (path) => {
      reads++;
      return ok(path.startsWith("test/") ? `from pkg.part${path.match(/\d+/)?.[0]} import x` : "");
    },
  );
  expect(selected.broad).toBeDefined();
  expect([...selected.core]).toEqual([["pkg/entry.py", ["O001"]]]);
  expect(reads).toBe(1);
});

it("reviews and closes a slice in a repository larger than one candidate copy", async () => {
  const p = await productWorkspace({ critic: true });
  projects.push(p);
  const w = p.workspace;
  for (let index = 0; index < 2100; index++)
    await w.write(`lib/part${String(index).padStart(4, "0")}.mjs`, `export const p${index} = 1;\n`);
  w.commit("existing repository");
  const updated = await updateProductBrief(await w.state(), {
    brief: {
      ...p.brief,
      slices: [{ ...p.brief.slices[0], scope: { allowed: ["**"], expected: [], forbidden: [] } }],
    },
    reason: "Review a change in a large repository",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
  await w.write("src/value.mjs", "export const value = 2;\n");
  const config = {
    ...(balancedCritic("codex") as NonNullable<ReturnType<typeof balancedCritic>>),
    maxCalls: 2,
  };
  const configured = await runProductCritic(await w.state(), {
    task: "T001",
    operation: "configure",
    config,
  });
  expect(configured.ok, JSON.stringify(configured)).toBe(true);
  let reviewed: CriticPacket | undefined;
  const host = {
    inspect: async () => ({
      harness: "codex" as const,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      freshContext: true,
      images: true,
      readOnly: true,
      delegationAllowed: true,
    }),
    review: async (packet: CriticPacket) => {
      reviewed = packet;
      const source = packet.current.sources.find((entry) => entry.reference === "src/value.mjs");
      const execution = packet.current.evidence.find(
        (entry) => entry.kind === "execution" && entry.status === "available",
      );
      return {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        context: "fresh" as const,
        response: {
          summary: "Inspected the changed module and its passing check",
          assessments: [
            {
              outcome: "O001",
              status: "satisfied" as const,
              summary: "The module returns two and its check passed",
              evidence: [source?.id ?? "missing", execution?.id ?? "missing"],
              expectations: [],
            },
          ],
          findings: [],
          limitations: [],
          resolutions: [],
          disputes: [],
        },
      };
    },
  };
  const done = await runProductDoneReviewed(await w.state(), { task: "T001" }, inlineReview(host));
  expect(done, JSON.stringify(done).slice(0, 2000)).toMatchObject({
    ok: true,
    value: { closed: true, critic: { reviewed: true } },
  });
  expect(reviewed?.current.sources.some((source) => source.id === "CODE-SCOPE")).toBe(true);
}, 120000);
