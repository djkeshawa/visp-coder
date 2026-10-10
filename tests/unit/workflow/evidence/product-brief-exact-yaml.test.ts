import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { createProductFeature } from "../../../../src/workflow/product/brief.js";
import { exactYaml, readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

// A GitHub issue body: long folded lines around whitespace-only lines that hold tabs.
const LONG =
  "This project uses VISP. Read AGENTS.md and the instructions it references before starting, and follow them carefully.";
const PASTED = `${LONG}\n\nDescription\n\t \n\t\t(last modified by Someone)\n\t \nIt does not work when I set the widget parameter.\n${LONG}\n`;

it("writes YAML whose strings read back exactly, keeping ordinary output unchanged", () => {
  // The default folded style changes this text on the way back in.
  expect(parse(stringify({ originalRequest: PASTED })).originalRequest).not.toBe(PASTED);
  expect(parse(exactYaml({ originalRequest: PASTED })).originalRequest).toBe(PASTED);
  const plain = { goal: "Return two", slices: [{ id: "T001", goal: "One usable slice" }] };
  expect(exactYaml(plain)).toBe(stringify(plain));
});

it("keeps a pasted request with tab-only lines usable for work", async () => {
  workspace = await TestWorkspace.create({ "src/value.mjs": "export const value = 1;\n" });
  await workspace.installFoundation();
  workspace.commit("install foundation");
  const created = await createProductFeature(await workspace.state(), {
    goal: "Fix the widget override",
    sourceBrief: PASTED,
    branch: false,
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const record = await readProductRecord(await workspace.state(), {});
  expect(record.ok && record.value.brief.originalRequest).toBe(
    record.ok ? record.value.state.intentSnapshot.originalRequest : "",
  );
  const work = await runProductWork(await workspace.state(), {
    check: "node --check src/value.mjs",
  });
  expect(work.ok, JSON.stringify(work)).toBe(true);
  const feature = record.ok ? record.value.brief.feature : "";
  const saved = await readFile(
    join(workspace.root, ".visp", "features", feature, "brief.yaml"),
    "utf8",
  );
  expect(parse(saved).originalRequest).toContain("\t \n\t\t(last modified by Someone)\n\t \n");
});
