import { describe, expect, it } from "vitest";
import {
  featureFoundationError,
  foundationBlockers,
  implementationFoundationError,
  inheritedChangedFiles,
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

  // A worker read "git commit the project baseline" and discarded a previous session's
  // uncommitted work with git checkout instead.
  it("requires uncommitted changes to be committed, never discarded, before a feature starts", () => {
    const error = featureFoundationError(
      {
        repositoryAvailable: true,
        harnessInstalled: true,
        enforcementInstalled: true,
        hasBaseline: true,
        changedFiles: ["visp.yml", "AGENTS.visp.md"],
      },
      'visp feature "<goal>"',
    );
    expect(error).toMatchObject({
      code: "STAGE_BLOCKED",
      recovery:
        'git add -A && git commit -m "<what these changes are>", then visp feature "<goal>"',
    });
    expect(error?.message).toContain("may be earlier work");
    expect(error?.message).toContain("do not discard");
  });

  // Codex's workspace-write sandbox keeps .git read-only: the commit can never succeed.
  it("starts a feature on uncommitted changes that Git cannot commit, inheriting them", () => {
    const context = {
      repositoryAvailable: true,
      harnessInstalled: true,
      enforcementInstalled: true,
      hasBaseline: true,
      changedFiles: ["app.js", "visp.yml"],
      gitWritable: false,
    };
    expect(featureFoundationError(context, "visp feature")).toBeUndefined();
    expect(inheritedChangedFiles(context)).toEqual(["app.js", "visp.yml"]);
    expect(inheritedChangedFiles({ ...context, gitWritable: true })).toEqual([]);
    expect(inheritedChangedFiles({ ...context, gitWritable: undefined })).toEqual([]);
    expect(
      featureFoundationError({ ...context, gitWritable: true }, "visp feature")?.message,
    ).toContain("Git accepts writes here");
  });

  it("does not waive the other feature blockers when Git is read-only", () => {
    const blocked = featureFoundationError(
      {
        repositoryAvailable: true,
        harnessInstalled: true,
        enforcementInstalled: false,
        hasBaseline: true,
        changedFiles: ["app.js"],
        gitWritable: false,
      },
      "visp feature",
    );
    expect(blocked?.message).toContain("assets-only or CI-only");
  });
});
