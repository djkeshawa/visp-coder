import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSession, recordActivity } from "../../../src/orchestrate/session.js";
import { TestWorkspace } from "../support/workspace.js";

describe("session artifact compatibility", () => {
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await workspace?.destroy();
    workspace = undefined;
  });

  it("reads activity written before runtime identity and skill-use fields existed", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    const branch = workspace.git("branch", "--show-current").trim();
    await mkdir(dirname(state.paths.session), { recursive: true });
    await writeFile(
      state.paths.session,
      JSON.stringify({
        kind: "sessions",
        createdAt: "2026-01-01T00:00:00.000Z",
        sessions: {
          [branch]: {
            kind: "session",
            createdAt: "2026-01-01T00:00:00.000Z",
            branch,
            activity: [
              {
                command: "done",
                outcome: "ok",
                at: "2026-01-01T00:00:01.000Z",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const session = await readSession(state);
    expect(session.ok).toBe(true);
    expect(session.ok && session.value.activity[0]).toMatchObject({
      command: "done",
      skills: [],
    });
    expect(session.ok && session.value.activity[0]?.runtime).toBeUndefined();
  });

  it("keeps the complete activity history used by capability reporting", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();

    for (let index = 0; index < 25; index += 1) {
      await recordActivity(state, {
        command: "query",
        outcome: "ok",
        detail: `search ${index}`,
      });
    }

    const session = await readSession(state);
    expect(session.ok && session.value.activity).toHaveLength(25);
    expect(session.ok && session.value.activity[0]?.detail).toBe("search 0");
  });

  it("keeps only the newest 1000 activity entries", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    const branch = workspace.git("branch", "--show-current").trim();
    await mkdir(dirname(state.paths.session), { recursive: true });
    const at = "2026-01-01T00:00:00.000Z";
    await writeFile(
      state.paths.session,
      JSON.stringify({
        kind: "sessions",
        createdAt: at,
        sessions: {
          [branch]: {
            kind: "session",
            createdAt: at,
            branch,
            activity: Array.from({ length: 1000 }, (_, index) => ({
              command: "query",
              outcome: "ok",
              detail: `old ${index}`,
              at,
            })),
          },
        },
      }),
      "utf8",
    );

    for (let index = 0; index < 5; index += 1)
      await recordActivity(state, { command: "query", outcome: "ok", detail: `new ${index}` });

    const session = await readSession(state);
    const activity = session.ok ? session.value.activity : [];
    expect(activity).toHaveLength(1000);
    expect(activity[0]?.detail).toBe("old 5");
    expect(activity.at(-1)?.detail).toBe("new 4");
  });
});
