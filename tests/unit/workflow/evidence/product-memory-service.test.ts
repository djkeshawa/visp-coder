import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { TestWorkspace } from "../../support/workspace.js";

// The model calls are replaced: these tests cover which path `visp feature` takes.
const gate = vi.fn();
vi.mock("../../../../src/workflow/product/memory-gate.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  codexMemoryGate: () => gate,
}));
vi.mock("../../../../src/workflow/product/rule-extraction.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  codexRuleExtractor: () => async () => [],
}));

const { createProductFeature } = await import("../../../../src/workflow/product/brief.js");

const NOTES = [
  "An archived item cannot be reserved: 409 item_archived.",
  "Items hold at most 10000 units.",
];
let workspace: TestWorkspace | undefined;

afterEach(() => {
  gate.mockReset();
  workspace = undefined;
});

/** A project whose Visp Memory is a script that logs every call and returns two notes. */
async function project(memory: Record<string, unknown>, critic?: Record<string, unknown>) {
  workspace = await TestWorkspace.create(
    { "src/items.ts": "export const items = 1;\n" },
    {
      critic: Boolean(critic),
    },
  );
  await workspace.installFoundation();
  const log = join(workspace.root, ".memory-calls");
  const fake = join(workspace.root, ".fake-visp-memory");
  const sections = { decisions: NOTES.map((note) => ({ content: `Decision: ${note}` })) };
  await writeFile(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nif [ "$1" = brief ]; then printf '%s' '${JSON.stringify({ abstained: false, sections })}'; fi\n`,
  );
  await chmod(fake, 0o755);
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.memory = {
    ...config.memory,
    ...memory,
    service: { command: fake, ...(memory.service ?? {}) },
  };
  if (critic) config.critic = { ...config.critic, ...critic };
  await workspace.write("visp.yml", stringify(config));
  await workspace.write(".gitignore", ".memory-calls\n.fake-visp-memory\n.visp/session/\n");
  workspace.commit("configure memory");
  return { log };
}

async function feature(goal: string, prompt: string) {
  if (!workspace) throw new Error("no workspace");
  await mkdir(join(workspace.root, ".visp/session"), { recursive: true });
  await writeFile(
    join(workspace.root, ".visp/session/user-prompts.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), prompt })}\n`,
  );
  const created = await createProductFeature(await workspace.state(), { goal, branch: false });
  if (!created.ok) throw new Error(created.error.message);
  workspace.commit(goal);
  return created.value;
}

it("carries Visp Memory's own selection when no reviewer model chooses", async () => {
  const { log } = await project({});
  await feature("Archive items", "Add archiving. An archived item cannot be reserved.");
  const second = await feature("Bundles", "Add bundle reservations.");
  expect(second.projectMemory).toEqual(NOTES);
  expect(second.brief.originalRequest).toContain(`M2 ${NOTES[1]}`);
  expect((await readFile(log, "utf8")).split("\n")).toContain("decision");
  expect(gate).not.toHaveBeenCalled();
});

it("carries only the notes the reviewer's model chooses", async () => {
  await project({}, { enabled: true, harness: "codex", launch: "codex-exec" });
  gate.mockResolvedValue([NOTES[1]]);
  await feature("Archive items", "Add archiving.");
  const second = await feature("Restock", "Add restocking.");
  expect(gate).toHaveBeenCalledWith(expect.stringContaining("Add restocking."), NOTES);
  expect(second.projectMemory).toEqual([NOTES[1]]);
});

it("falls back to Visp Memory's selection when the model fails", async () => {
  await project({}, { enabled: true, harness: "codex", launch: "codex-exec" });
  gate.mockRejectedValue(new Error("offline"));
  await feature("Archive items", "Add archiving.");
  const second = await feature("Restock", "Add restocking.");
  expect(second.projectMemory).toEqual(NOTES);
});

it("uses keyword selection when the project asks for it", async () => {
  await project(
    { service: { select: "keyword" } },
    { enabled: true, harness: "codex", launch: "codex-exec" },
  );
  await feature("Archive items", "Add archiving.");
  const second = await feature("Restock", "Add restocking.");
  expect(gate).not.toHaveBeenCalled();
  expect(second.projectMemory).toEqual(NOTES);
});

// Review: memory.enabled: false must switch off the long-term store too.
it("never calls the service when memory is turned off", async () => {
  const { log } = await project({ enabled: false });
  await feature("Archive items", "Add archiving.");
  const second = await feature("Bundles", "Add bundles.");
  expect(second.projectMemory).toBeUndefined();
  await expect(readFile(log, "utf8")).rejects.toThrow();
});
