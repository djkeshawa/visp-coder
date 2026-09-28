import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  applyFileTransaction,
  inspectFileTransactions,
} from "../../../src/core/file-transaction.js";
import { ok } from "../../../src/core/result.js";
import * as ownership from "../../../src/core/state-lock.js";
import { inspectSettledTransactions } from "../../../src/core/transaction-inspection.js";

it("rechecks journals when the owner finishes between journal and lock inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "visp-settled-"));
  try {
    await applyFileTransaction(
      root,
      "finishing",
      [{ kind: "write", path: "state", content: "after" }],
      {
        leavePreparedOnError: true,
        afterMutation() {
          throw new Error("prepared");
        },
      },
    );
    const journals = await inspectFileTransactions(root);
    if (!journals.ok) throw new Error(journals.error.message);
    const inspect = vi.spyOn(ownership, "inspectStateLock").mockImplementationOnce(async () => {
      await rm(join(root, ".visp/state/transactions", `${journals.value.pending[0]}.json`));
      return ok({ state: "unlocked" });
    });
    try {
      expect(await inspectSettledTransactions(root)).toEqual(
        ok({ pending: [], committed: [], saving: false }),
      );
    } finally {
      inspect.mockRestore();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
