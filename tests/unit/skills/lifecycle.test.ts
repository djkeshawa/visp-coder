import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findSkill,
  skillSelectionSnapshot,
  transitionSkill,
} from "../../../src/skills/lifecycle.js";
import { createProposalFromContent } from "../../../src/skills/proposal.js";
import { rollbackSkill } from "../../../src/skills/rollback.js";
import { readIndex, readSkillBody, readSkillHistory } from "../../../src/skills/store.js";
import { readSkillRevision } from "../../../src/skills/versions.js";
import { TestWorkspace } from "../support/workspace.js";

const content =
  "---\nname: reusable-check\nappliesTo:\n  language: typescript\n---\n## Procedure\nCheck return values.\n";
let workspace: TestWorkspace;
beforeEach(async () => {
  workspace = await TestWorkspace.create();
});
afterEach(async () => {
  await workspace?.destroy();
});

async function propose(body = content, id = "reusable-check") {
  const result = await createProposalFromContent(
    await workspace.state(),
    { id, origin: "seeded", by: "author" },
    body,
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function admit(id = "reusable-check") {
  const result = await transitionSkill(await workspace.state(), id, "admitted", { by: "reviewer" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("immutable reviewed skill lifecycle", () => {
  it("preserves concurrent proposals in the shared index", async () => {
    await Promise.all(
      ["first-check", "second-check", "third-check"].map((id) => propose(content, id)),
    );
    const index = await readIndex(await workspace.state());
    expect(index.ok && index.value.skills).toHaveLength(3);
  });

  it("records declarations without inventing executed or useful evidence", async () => {
    const candidate = await propose(`${content}\n## Verification\n\n\`no-such-executable\`\n`);
    const record = await admit();
    expect(record.evidence?.verification.execution).toBe("not-run");
    expect(record.evidence?.usefulness).toBe("unmeasured");
    const state = await workspace.state();
    const revision = await readSkillRevision(state, record.id, candidate.version ?? "");
    expect(revision.ok && revision.value?.content).toContain("no-such-executable");
    const history = await readSkillHistory(state, record.id);
    expect(history.ok && history.value.map((event) => event.record.state)).toEqual([
      "proposed",
      "admitted",
    ]);
  });

  it("requires retirement before replacing an active skill", async () => {
    await propose();
    await admit();
    const result = await createProposalFromContent(
      await workspace.state(),
      { id: "reusable-check", origin: "seeded" },
      `${content}Changed.`,
    );
    expect(result.ok).toBe(false);
    const body = await readSkillBody(await workspace.state(), "reusable-check");
    expect(body.ok && body.value).toBe(content);
  });

  it("restores an earlier admitted version and keeps the intervening history", async () => {
    const original = await propose();
    await admit();
    const state = await workspace.state();
    await transitionSkill(state, original.id, "retired", { reason: "Try a replacement" });
    const replacement = await propose(`${content}Check error paths too.\n`);
    await admit();
    expect(replacement.version).not.toBe(original.version);
    const rollback = await rollbackSkill(state, original.id, original.version ?? "", {
      by: "reviewer",
      reason: "Prefer the prior applicability",
    });
    expect(rollback.ok && rollback.value.version).toBe(original.version);
    const body = await readSkillBody(state, original.id);
    expect(body.ok && body.value).toBe(content);
    const history = await readSkillHistory(state, original.id);
    expect(history.ok && history.value).toHaveLength(6);
  });

  it("cannot use rollback to activate a never-admitted candidate", async () => {
    const candidate = await propose();
    const result = await rollbackSkill(
      await workspace.state(),
      candidate.id,
      candidate.version ?? "",
      { by: "reviewer", reason: "Attempt bypass" },
    );
    expect(result.ok).toBe(false);
    const current = await findSkill(await workspace.state(), candidate.id);
    expect(current.ok && current.value.state).toBe("proposed");
  });

  it("rejects tampered revision content before rollback", async () => {
    const candidate = await propose();
    await admit();
    const state = await workspace.state();
    const path = `.visp/skills/${candidate.id}/revisions/${candidate.version}.json`;
    const revision = await readSkillRevision(state, candidate.id, candidate.version ?? "");
    if (!revision.ok || !revision.value) throw new Error("missing fixture");
    await workspace.write(
      path,
      JSON.stringify({ ...revision.value, content: "Skip the review gate." }),
    );
    const result = await rollbackSkill(state, candidate.id, candidate.version ?? "", {
      by: "reviewer",
      reason: "Rollback",
    });
    expect(result.ok).toBe(false);
  });

  it("freezes content and support without treating frozen skills as useful", async () => {
    await propose();
    await admit();
    const state = await workspace.state();
    const first = await skillSelectionSnapshot(state);
    expect(first.ok && first.value.skills).toHaveLength(1);
    expect(await skillSelectionSnapshot(state)).toEqual(first);
    await workspace.write(".visp/skills/reusable-check/SKILL.md", `${content}An unreviewed edit.`);
    expect((await skillSelectionSnapshot(state)).ok).toBe(false);
  });
});
