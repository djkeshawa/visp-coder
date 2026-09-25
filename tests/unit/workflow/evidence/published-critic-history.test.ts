import { expect, it } from "vitest";
import { ok } from "../../../../src/core/result.js";
import { readCriticBudgetHistory } from "../../../../src/workflow/product/critic-budget-history.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";

it("reads a beta.3-shaped source-only failure without rewriting its historical spending record", async () => {
  // v0.4.0-beta.3 stored these two ignored limits in critic config and did not
  // yet create a feature-wide budget. A failed native attempt still spent a call.
  const original = `${JSON.stringify(
    {
      version: 1,
      root: "old-checkout",
      feature: "001-return-two",
      task: "T001",
      contract: "original-contract",
      intent: "original-intent",
      config: {
        harness: "codex",
        transport: "native",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        maxCalls: 2,
        timeoutMs: 180_000,
        maxImageBytes: 4 * 1024 * 1024,
        maxOutputTokens: 4_000,
        maxInputCharacters: 40_000,
      },
      disabled: false,
      attempts: [
        {
          id: "01234567-89ab-4cde-8fab-0123456789ab",
          phase: "product",
          candidate: "CAN-original",
          subject: "original-subject",
          contract: "original-contract",
          implementation: "original-implementation",
          evidenceDigest: "original-evidence",
          selectionDigest: "original-selection",
          transport: "native",
          sourceOnly: true,
          startedAt: 1,
          status: "unavailable",
          failureKind: "invocation-failed",
          message: "Invocation outcome unknown",
        },
      ],
    },
    null,
    2,
  )}\n`;
  const state = {
    files: {
      readText: async () => ok(original),
      metadata: async () => ok({ mode: 0o600 }),
    },
  } as unknown as WorkspaceState;

  const read = await readCriticBudgetHistory(
    state,
    "/project/.visp/features/001-return-two/critic/old.json",
  );
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.value.state.attempts).toHaveLength(1);
  expect(read.value.state.attempts[0]).toMatchObject({
    status: "unavailable",
    sourceOnly: true,
    failureKind: "invocation-failed",
  });
  expect(read.value.state.config).toMatchObject({ maxCalls: 2, timeoutMs: 180_000 });
  expect(read.value.state.config).not.toHaveProperty("maxOutputTokens");
  expect(read.value.state.config).not.toHaveProperty("maxInputCharacters");
  expect(read.value.guard).toMatchObject({ kind: "write", content: original, mode: 0o600 });
});
