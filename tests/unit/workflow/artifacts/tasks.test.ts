import { describe, expect, it } from "vitest";
import type { Task, TaskGraph } from "../../../../src/workflow/artifacts/tasks.js";
import { findTask, taskGraphSchema } from "../../../../src/workflow/artifacts/tasks.js";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    taskClass: "feature",
    riskLevel: "low",
    status: "pending",
    requirements: [],
    qualityRequirements: [],
    scenarios: [],
    modules: [],
    dependsOn: [],
    allowedFiles: [],
    expectedFiles: [],
    forbiddenFiles: [],
    validationCommands: [],
    validationFiles: [],
    probeRoles: [],
    doneCriteria: [],
    ...overrides,
  };
}

function graph(tasks: Task[]): TaskGraph {
  return {
    kind: "tasks",
    createdAt: "2026-01-01T00:00:00.000Z",
    feature: "001-example",
    tasks,
    draft: false,
  };
}

describe("taskGraphSchema", () => {
  const base = {
    kind: "tasks",
    createdAt: "2026-01-01T00:00:00.000Z",
    feature: "001-example",
  };

  it("accepts a valid graph and applies task defaults", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [{ id: "T001", title: "Do the thing" }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tasks[0]?.status).toBe("pending");
    expect(parsed.data.tasks[0]?.allowedFiles).toEqual([]);
    expect(parsed.data.tasks[0]?.validationFiles).toEqual([]);
    expect(parsed.data.tasks[0]?.probeRoles).toEqual([]);
    expect(parsed.data.tasks[0]?.validationChecks).toBeUndefined();
    expect(parsed.data.tasks[0]?.concerns).toBeUndefined();
  });

  it("accepts explicit domain-neutral engineering concerns", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [
        {
          id: "T001",
          title: "Do the thing",
          concerns: ["custom-logic", "cross-boundary", "user-interaction", "visual-quality"],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tasks[0]?.concerns).toEqual([
      "custom-logic",
      "cross-boundary",
      "user-interaction",
      "visual-quality",
    ]);
  });

  it("rejects invented concern categories instead of silently ignoring them", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [{ id: "T001", title: "Do the thing", concerns: ["magic-behavior"] }],
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts explicit layered validation while preserving old task shapes", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [
        {
          id: "T001",
          title: "Do the thing",
          validationChecks: [{ layer: "integration", command: ["pnpm", "test:integration"] }],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tasks[0]?.validationChecks?.[0]?.layer).toBe("integration");
  });

  it("rejects duplicate task ids", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [
        { id: "T001", title: "A" },
        { id: "T001", title: "B" },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a dependency on an unknown task", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [{ id: "T001", title: "A", dependsOn: ["T099"] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a task that depends on itself", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [{ id: "T001", title: "A", dependsOn: ["T001"] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a file scope that escapes the repository", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [{ id: "T001", title: "A", allowedFiles: ["../outside.ts"] }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an absolute file scope", () => {
    const parsed = taskGraphSchema.safeParse({
      ...base,
      tasks: [{ id: "T001", title: "A", allowedFiles: ["/etc/passwd"] }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("findTask", () => {
  it("finds a task by id and reports a miss as undefined", () => {
    const subject = graph([task("T001")]);
    expect(findTask(subject, "T001")?.id).toBe("T001");
    expect(findTask(subject, "T999")).toBeUndefined();
  });
});
