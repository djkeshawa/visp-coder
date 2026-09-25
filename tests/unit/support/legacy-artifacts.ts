import { now } from "../../../src/workflow/artifacts/common.js";
import type { Plan, Spec } from "../../../src/workflow/artifacts/feature.js";
import type { TaskGraph } from "../../../src/workflow/artifacts/tasks.js";

// Constructors for historical records exercised by migration and evidence regressions.
// No production path generates, validates, or mutates the retired stage workflow.
const PLACEHOLDER = "TODO";

export function seedSpec(feature: string, options: { structured?: boolean } = {}): Spec {
  return {
    kind: "spec",
    createdAt: now(),
    feature,
    summary: `${PLACEHOLDER}: one paragraph on what this change does and for whom`,
    requirements: [
      {
        id: "REQ001",
        statement: `${PLACEHOLDER}: a testable statement of what must be true`,
        priority: "must",
        criteria: [
          {
            id: "AC001",
            statement: `${PLACEHOLDER}: how someone checks REQ001 is met`,
            verificationKind: "command",
            verification: `\`${PLACEHOLDER}: runnable command\``,
            verificationLayer: "functional",
            verificationEnvironment: "project",
          },
        ],
      },
    ],
    researchFindings: [],
    qualityRequirements: options.structured
      ? [
          {
            id: "NFR001",
            category: "maintainability",
            statement: `${PLACEHOLDER}: an observable quality the implementation must preserve`,
            target: `${PLACEHOLDER}: a measurable threshold or explicit boundary`,
            priority: "must",
            criteria: [],
          },
        ]
      : [],
    behaviorScenarios: options.structured
      ? [
          {
            id: "SCN001",
            title: `${PLACEHOLDER}: a load-bearing behaviour`,
            given: [`${PLACEHOLDER}: relevant starting state`],
            when: `${PLACEHOLDER}: the triggering action or event`,
            expected: [`${PLACEHOLDER}: an observable outcome`],
            requirements: ["REQ001"],
            criteria: ["AC001"],
          },
        ]
      : [],
    outOfScope: [],
    openQuestions: [],
    draft: true,
  };
}

export function seedPlan(feature: string, options: { structured?: boolean } = {}): Plan {
  return {
    kind: "plan",
    createdAt: now(),
    feature,
    approach: `${PLACEHOLDER}: how the change will be made, and which parts of the codebase it touches`,
    researchFindings: [],
    decisions: [],
    modules: options.structured
      ? [
          {
            name: `${PLACEHOLDER}: cohesive module name`,
            paths: [`${PLACEHOLDER}/**/*`],
            responsibility: `${PLACEHOLDER}: one clear responsibility and boundary`,
            owns: [],
            dependsOn: [],
            publicInterfaces: [],
          },
        ]
      : [],
    invariants: [],
    testStrategy: options.structured
      ? [
          {
            layer: "unit",
            covers: ["REQ001"],
            approach: `${PLACEHOLDER}: the cheapest test that settles this behaviour`,
          },
        ]
      : [],
    risks: [],
    newDependencies: [],
    draft: true,
  };
}

export function seedTaskGraph(feature: string, spec: Spec | undefined, plan?: Plan): TaskGraph {
  const requirements = spec?.requirements.map((requirement) => requirement.id) ?? [];
  const qualityRequirements = spec?.qualityRequirements.map((requirement) => requirement.id) ?? [];
  const scenarios = spec?.behaviorScenarios.map((scenario) => scenario.id) ?? [];

  return {
    kind: "tasks",
    createdAt: now(),
    feature,
    draft: true,
    tasks: [
      {
        id: "T001",
        title: `${PLACEHOLDER}: one unit of work`,
        description: "",
        taskClass: "feature",
        riskLevel: "low",
        status: "pending",
        requirements: requirements.slice(0, 1),
        qualityRequirements: qualityRequirements.slice(0, 1),
        scenarios: scenarios.slice(0, 1),
        modules: plan?.modules.slice(0, 1).map((module) => module.name) ?? [],
        concerns: [],
        dependsOn: [],
        allowedFiles: [`${PLACEHOLDER}/**/*`],
        expectedFiles: [],
        forbiddenFiles: [],
        validationCommands: [],
        validationChecks: [],
        validationFiles: [],
        probeRoles: [],
        doneCriteria: [],
      },
    ],
  };
}
