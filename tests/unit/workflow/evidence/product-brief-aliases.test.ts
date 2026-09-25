import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { normalizeBriefInput } from "../../../../src/workflow/product/brief-aliases.js";
import { type ProductBrief, parseProductBrief } from "../../../../src/workflow/product/model.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

interface RejectedCase {
  run: string;
  rejection: string;
  brief: Record<string, unknown>;
}
const corpus: { cases: RejectedCase[] } = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/product-briefs/rejected-2026-09-20.json", import.meta.url),
    "utf8",
  ),
);

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function recorded(brief: Record<string, unknown>): ProductBrief {
  return value(
    parseProductBrief({
      version: 2,
      feature: brief.feature,
      originalRequest: brief.originalRequest,
      goal: brief.goal,
    }),
  );
}

// A manual check has no command VISP could execute; that rejection is intended.
const residual: Record<number, string> = {
  0: "Invalid brief:\nchecks.2.command: Invalid input\nchecks.2: Unrecognized key(s) in object: 'kind', 'description'",
};

it.each(corpus.cases.map((entry, index) => [index, entry.run, entry] as const))(
  "accepts real rejected brief %i from %s after reported normalization",
  (index, _run, entry) => {
    expect(parseProductBrief(entry.brief).ok).toBe(false);
    const before = JSON.stringify(entry.brief);
    const normalized = normalizeBriefInput(entry.brief, "brief", recorded(entry.brief));
    const parsed = parseProductBrief(normalized.value);
    expect(parsed.ok ? "accepted" : parsed.error.message).toBe(residual[index] ?? "accepted");
    expect(normalized.normalized.length).toBeGreaterThan(0);
    expect(JSON.stringify(entry.brief)).toBe(before);
  },
);

it("keeps an ambiguous outcome kind rejected instead of guessing", () => {
  const brief = corpus.cases[0]?.brief ?? {};
  const input = {
    ...brief,
    outcomes: [{ id: "O001", kind: "banana", statement: "A result is returned" }],
  };
  const parsed = parseProductBrief(normalizeBriefInput(input, "brief", recorded(brief)).value);
  expect(parsed.ok).toBe(false);
});

it("turns an acceptance criterion naming an outcome into that outcome's expectation", () => {
  const brief = corpus.cases[2]?.brief ?? {};
  const normalized = normalizeBriefInput(brief, "brief", recorded(brief));
  const parsed = value(parseProductBrief(normalized.value));
  expect(parsed.acceptanceBaseline).toEqual([]);
  expect(parsed.outcomes.find((outcome) => outcome.id === "O1")?.expectations).toContainEqual(
    expect.objectContaining({
      statement: "Real browser interaction visibly changes projectile, plane, and score state.",
    }),
  );
  expect(normalized.normalized.join("\n")).toContain("O1 expectation");
});

it("renames nonconforming slice IDs and the dependencies that name them", () => {
  const brief = corpus.cases[2]?.brief ?? {};
  const parsed = value(
    parseProductBrief(normalizeBriefInput(brief, "brief", recorded(brief)).value),
  );
  expect(parsed.slices.map((slice) => slice.id)).toEqual(["T001", "T002"]);
  expect(parsed.slices[1]?.dependsOn.every((id) => id.startsWith("T"))).toBe(true);
});

it("keeps a slice's extra description as its approach", () => {
  const brief = corpus.cases[1]?.brief ?? {};
  const slices = [
    { id: "T001", title: "Serve", description: "Use the standard library", scope: ["api.py"] },
  ];
  const normalized = normalizeBriefInput({ ...brief, slices }, "brief", recorded(brief));
  expect((normalized.value as { slices: unknown[] }).slices[0]).toEqual({
    id: "T001",
    goal: "Serve",
    approach: "Use the standard library",
    scope: { allowed: ["api.py"] },
  });
});

it("does not fill fields a patch leaves unchanged on an existing entry", () => {
  const previous = value(
    parseProductBrief({
      version: 2,
      feature: "001-example",
      originalRequest: "Return a value",
      goal: "Return a value",
      outcomes: [{ id: "O001", kind: "quality", statement: "Fast" }],
    }),
  );
  const normalized = normalizeBriefInput(
    { feature: "001-example", outcomes: [{ id: "O001", description: "Fast enough" }] },
    "patch",
    previous,
  );
  expect(normalized.value).toEqual({ outcomes: [{ id: "O001", statement: "Fast enough" }] });
});

it("reports normalization through the brief update used by CLI and MCP", async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  const updated = value(
    await updateProductBrief(await workspace.state(), {
      reason: "Record behavior examples in the author's own words",
      patch: {
        examples: [
          // biome-ignore lint/suspicious/noThenProperty: models author `then`; it is the alias under test.
          { given: "A ready module", when: ["Read the value"], then: "Two", outcome: "O001" },
        ],
      },
    }),
  );
  expect(updated.examples.at(-1)).toMatchObject({
    title: "Read the value",
    given: ["A ready module"],
    when: "Read the value",
    expected: ["Two"],
    outcomes: ["O001"],
  });
  expect(updated.normalized).toContain("examples[0].then → expected");
});

it("lifts check objects written inside a slice into brief checks it references", () => {
  const brief = corpus.cases[1]?.brief ?? {};
  const input = {
    ...brief,
    checks: [],
    slices: [
      {
        id: "T001",
        goal: "Serve",
        outcomes: ["O001"],
        scope: { allowed: ["server.py"] },
        checks: [{ command: ["python3", "-m", "unittest"], outcomes: ["O001"] }],
      },
    ],
  };
  const normalized = normalizeBriefInput(input, "brief", recorded(brief));
  const parsed = value(parseProductBrief(normalized.value));
  expect(parsed.checks).toContainEqual(
    expect.objectContaining({ id: "T001-C1", command: ["python3", "-m", "unittest"] }),
  );
  expect(parsed.slices[0]?.checks).toEqual(["T001-C1"]);
  expect(normalized.normalized.join("\n")).toContain("slices[0].checks[0] → checks T001-C1");
});
