import { describe, expect, it } from "vitest";
import {
  featureFoundationError,
  foundationBlockers,
  implementationFoundationError,
} from "../../../../src/workflow/gates/readiness.js";

describe("implementation foundation", () => {
  it("reports every known feature blocker while retaining the repository refusal flags", () => {
    const context = {
      repositoryAvailable: false,
      harnessInstalled: false,
      enforcementInstalled: false,
      hasBaseline: false,
      changedFiles: ["app.js"],
    };
    const blocked = featureFoundationError(context, 'visp feature "game"');
    expect(blocked).toMatchObject({
      code: "STAGE_BLOCKED",
      recovery: "git init",
      details: { mayEdit: false, suppressFailure: false, restartAgentAfterSetup: true },
    });
    expect(
      foundationBlockers(context, "visp feature", true).map((issue) => issue.requirement),
    ).toEqual(["repository", "harness", "enforcement", "baseline", "clean-baseline"]);
    expect(blocked?.message).toContain(
      "assets-only or CI-only installation cannot authorize coding",
    );
    expect(blocked?.message).toContain("Complete installation before committing");
  });

  it("requires a clean baseline only for feature creation, not active implementation", () => {
    const context = {
      repositoryAvailable: true,
      harnessInstalled: true,
      enforcementInstalled: true,
      hasBaseline: true,
      changedFiles: ["app.js"],
    };
    expect(implementationFoundationError(context, "visp work")).toBeUndefined();
    expect(featureFoundationError(context, "visp feature")?.details?.blockers).toMatchObject([
      { requirement: "clean-baseline", changedFiles: ["app.js"] },
    ]);
  });
  it.each([
    [{ repositoryAvailable: false }, "git init"],
    [{ repositoryAvailable: true, harnessInstalled: false }, "visp install"],
    [
      { repositoryAvailable: true, harnessInstalled: true, enforcementInstalled: false },
      "visp install",
    ],
    [
      {
        repositoryAvailable: true,
        harnessInstalled: true,
        enforcementInstalled: true,
        hasBaseline: false,
      },
      "git commit the project baseline, then visp context T001",
    ],
  ])("fails closed with an actionable recovery", (state, recovery) => {
    expect(implementationFoundationError(state, "visp context T001")?.recovery).toBe(recovery);
  });

  it("passes only when Git, harness, enforcement, and baseline are ready", () => {
    expect(
      implementationFoundationError(
        {
          repositoryAvailable: true,
          harnessInstalled: true,
          enforcementInstalled: true,
          hasBaseline: true,
        },
        "visp context T001",
      ),
    ).toBeUndefined();
  });

  it("marks a missing repository as a non-editable bootstrap blocker", () => {
    expect(
      implementationFoundationError({ repositoryAvailable: false }, "visp context T001"),
    ).toMatchObject({
      code: "STAGE_BLOCKED",
      details: {
        blocker: "repository",
        mayEdit: false,
        restartAgentAfterSetup: true,
        suppressFailure: false,
      },
    });
  });

  it("requires setup changes to be committed before a feature starts", () => {
    expect(
      featureFoundationError(
        {
          repositoryAvailable: true,
          harnessInstalled: true,
          enforcementInstalled: true,
          hasBaseline: true,
          changedFiles: ["visp.yml", "AGENTS.visp.md"],
        },
        'visp feature "<goal>"',
      ),
    ).toMatchObject({
      code: "STAGE_BLOCKED",
      recovery: 'git commit the project baseline, then visp feature "<goal>"',
    });
  });
});
