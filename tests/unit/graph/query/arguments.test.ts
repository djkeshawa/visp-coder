import { afterEach, describe, expect, it } from "vitest";
import { resolveQueryTarget } from "../../../../src/graph/query/arguments.js";
import { openStore } from "../../../../src/graph/store/index.js";
import { type Fixture, indexFixture, makeRepo } from "../fixtures.js";

let repo: Fixture;
afterEach(async () => repo?.cleanup());

describe("query target resolution", () => {
  it("prefers project symbols over agent-worktree copies in an older snapshot", async () => {
    repo = await makeRepo({ "src/helper.ts": "export function helper() {}\n" });
    await indexFixture(repo);
    const opened = openStore(repo.storePath);
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const head = opened.value.requireHead();
      if (!head.ok) throw new Error(head.error.message);
      expect(
        opened.value.publishSnapshot({
          ...head.value,
          id: "old-with-agent-copy",
          entities: [
            ...head.value.entities,
            {
              id: ".claude/worktrees/w/src/helper.ts#function:helper",
              path: ".claude/worktrees/w/src/helper.ts",
              kind: "function",
              name: "helper",
              startLine: 1,
              endLine: 1,
            },
          ],
        }).ok,
      ).toBe(true);
      expect(resolveQueryTarget(opened.value, "callers", "helper")).toEqual({
        ok: true,
        value: "src/helper.ts#function:helper",
      });
    } finally {
      opened.value.close();
    }
  });

  it("reports every exact duplicate instead of choosing the first path", async () => {
    repo = await makeRepo({
      "bench/first.ts": "export function helper() {}\n",
      "src/second.ts": "export function helper() {}\n",
      ...Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          `bench/more-${index}.ts`,
          "export function helper() {}\n",
        ]),
      ),
    });
    await indexFixture(repo);
    const opened = openStore(repo.storePath);
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const result = resolveQueryTarget(opened.value, "callers", "helper");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("AMBIGUOUS");
        expect(result.error.message).toContain("bench/first.ts#function:helper");
        expect(result.error.message).toContain("src/second.ts#function:helper");
        expect(result.error.details?.candidates).toHaveLength(32);
      }
    } finally {
      opened.value.close();
    }
  });
});
