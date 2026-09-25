import { afterEach, expect, it } from "vitest";
import type { SkillEvaluation } from "../../../src/skills/evaluation.js";
import type { SkillRecord } from "../../../src/skills/schema.js";
import { succeeded } from "../support/product.js";
import { TestProject } from "../support/project.js";
import { syntheticSkillEvaluation } from "../support/skill-evaluation.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());

it("records claims without activation, gates promotion, and retires a harmful revision through the built CLI", async () => {
  project = await TestProject.create();
  succeeded(project, "init", "--harness", "generic");
  await project.write(
    "candidate.md",
    "---\nname: evaluated-procedure\nappliesTo:\n  taskClass: feature\n---\n\n## Procedure\nCheck the observed result.\n",
  );
  const candidate = project.json<SkillRecord>(
    "skill",
    "propose",
    "--id",
    "evaluated-procedure",
    "--file",
    "candidate.md",
    "--origin",
    "seeded",
  );
  expect(candidate.result.exitCode, candidate.result.stdout).toBe(0);
  const version = candidate.envelope.data?.version;
  if (!version) throw new Error("Missing candidate revision");
  const initial = succeeded(project, "skill", "show", "evaluated-procedure");
  const input = syntheticSkillEvaluation(version);
  const evaluate = async (value: unknown) => {
    if (!project) throw new Error("Missing project");
    await project.write(".visp/drafts/evaluation.json", JSON.stringify(value));
    return project.json<{ id: string; evaluation: SkillEvaluation; skill: SkillRecord }>(
      "skill",
      "evaluate",
      "evaluated-procedure",
      "--file",
      ".visp/drafts/evaluation.json",
      "--by",
      "fixture-reviewer",
    );
  };
  const promote = (id: string) => {
    if (!project) throw new Error("Missing project");
    return project.json<SkillRecord>(
      "skill",
      "promote",
      "evaluated-procedure",
      "--evaluation",
      id,
      "--by",
      "fixture-reviewer",
    );
  };
  const state = () => {
    if (!project) throw new Error("Missing project");
    return project.json<SkillRecord>("skill", "show", "evaluated-procedure").envelope.data;
  };
  const wrong = syntheticSkillEvaluation("0".repeat(64));
  expect((await evaluate(wrong)).result.exitCode).not.toBe(0);
  expect(succeeded(project, "skill", "show", "evaluated-procedure")).toBe(initial);
  expect(
    (await evaluate({ ...input, split: "pilot", confirmation: undefined })).result.exitCode,
  ).not.toBe(0);
  expect(succeeded(project, "skill", "show", "evaluated-procedure")).toBe(initial);

  const uncertain = await evaluate({
    ...input,
    decision: "inconclusive",
    split: "pilot",
    confirmation: undefined,
  });
  expect(uncertain.result.exitCode, uncertain.result.stdout).toBe(0);
  if (!uncertain.envelope.data) throw new Error("Missing inconclusive claim");
  expect(promote(uncertain.envelope.data.id).result.exitCode).not.toBe(0);
  expect(state()?.state).toBe("proposed");
  expect(uncertain.envelope.data.skill.state).toBe("proposed");

  const reviewed = await evaluate(input);
  expect(reviewed.result.exitCode, reviewed.result.stdout).toBe(0);
  const recorded = reviewed.envelope.data;
  if (!recorded) throw new Error("Missing beneficial claim");
  expect(recorded.skill.state).toBe("proposed");
  expect(recorded.evaluation.provenance).toBe("operator-supplied-analysis");
  expect(recorded.skill.evidence?.usefulnessBasis).toBe("operator-reviewed-claim");
  const path = `.visp/skills/evaluated-procedure/evaluations/${recorded.id}.json`;
  const original = await project.read(path);
  const tampered: SkillEvaluation = JSON.parse(original);
  tampered.input.rationale = "Changed after recording";
  await project.write(path, JSON.stringify(tampered));
  expect(promote(recorded.id).result.exitCode).not.toBe(0);
  expect(state()?.state).toBe("proposed");
  await project.write(path, original);
  const activated = promote(recorded.id);
  expect(activated.result.exitCode, activated.result.stdout).toBe(0);
  expect(activated.envelope.data).toMatchObject({
    state: "admitted",
    version,
    evidence: { usefulnessBasis: "operator-reviewed-claim" },
  });
  const harmful = await evaluate({
    ...input,
    decision: "harmful",
    confirmation: undefined,
    rationale: "Synthetic adverse follow-up",
  });
  expect(harmful.result.exitCode, harmful.result.stdout).toBe(0);
  expect(harmful.envelope.data?.skill.state).toBe("retired");
  expect(promote(recorded.id).result.exitCode).not.toBe(0);
  expect(state()?.state).toBe("retired");
  expect(await project.read(path)).toBe(original);
});
