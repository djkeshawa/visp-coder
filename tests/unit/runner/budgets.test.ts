import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFileTransaction,
  inspectFileTransactions,
  recoverFileTransactions,
} from "../../../src/core/file-transaction.js";
import { hashValue } from "../../../src/core/hash.js";
import {
  inspectStudyBudget,
  reserveStudyBudget,
  type StudyBudgetRequest,
} from "../../../src/runner/budgets.js";

let root: string;
const request: StudyBudgetRequest = {
  study: "pilot",
  studyApprovalId: "approved-pilot",
  studyMaxEstimatedUsd: 3,
  runId: "run-one",
  runSpecHash: "a".repeat(64),
  maxEstimatedUsd: 1,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-runner-budget-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("conservative study allocations", () => {
  it("refuses a complete-looking allocation while its transaction can still roll back", async () => {
    const first = await reserveStudyBudget(root, request);
    const { hash: firstHash, ...firstBody } = first;
    const body = {
      ...firstBody,
      runId: "uncommitted-attempt",
      sequence: 2,
      previousHash: firstHash,
      cumulativeMicroUsd: "2000000",
    };
    const second = { ...body, hash: hashValue(body) };
    const ledger = join(root, ".visp-runner", "studies", request.study);
    const interrupted = await applyFileTransaction(
      root,
      "interrupted-budget-commit",
      [
        {
          kind: "write",
          path: join(ledger, "reservations", "00000002.json"),
          content: JSON.stringify(second),
        },
        {
          kind: "write",
          path: join(root, second.runId, "budget-reservation.json"),
          content: JSON.stringify(second),
        },
        {
          kind: "write",
          path: join(ledger, "projection.json"),
          content: JSON.stringify({
            schemaVersion: 1,
            approvalHash: second.approvalHash,
            count: 2,
            head: second.hash,
            allocatedMicroUsd: second.cumulativeMicroUsd,
          }),
        },
      ],
      {
        leavePreparedOnError: true,
        afterMutation: (applied) => {
          if (applied === 3) throw new Error("Stopped before the transaction commit marker");
        },
      },
    );
    expect(!interrupted.ok && interrupted.error.message).toContain(
      "Stopped before the transaction commit marker",
    );
    const journals = await inspectFileTransactions(root);
    expect(journals.ok && journals.value.pending).toHaveLength(1);
    await expect(inspectStudyBudget(root, request.study)).rejects.toThrow(
      /unfinished.*transaction/i,
    );
    expect((await recoverFileTransactions(root)).ok).toBe(true);
    const recovered = await inspectStudyBudget(root, request.study);
    expect(recovered.reservations).toEqual([first]);
    expect(recovered.remainingMicroUsd).toBe("2000000");
  });

  it("reserves each full attempt maximum without concurrent over-allocation", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        reserveStudyBudget(root, { ...request, runId: `run-${index}` }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(9);
    const budget = await inspectStudyBudget(root, request.study);
    expect(budget.reservations).toHaveLength(3);
    expect(new Set(budget.reservations.map((entry) => entry.runId)).size).toBe(3);
    expect(budget.allocatedMicroUsd).toBe("3000000");
    expect(budget.remainingMicroUsd).toBe("0");
  });

  it("does not reuse an attempt reservation or silently change its approved ceiling", async () => {
    await reserveStudyBudget(root, request);
    await expect(reserveStudyBudget(root, request)).rejects.toThrow(/already reserved/i);
    for (const changed of [
      { studyMaxEstimatedUsd: 4 },
      { studyApprovalId: "replacement-approval" },
    ]) {
      await expect(
        reserveStudyBudget(root, { ...request, runId: "run-two", ...changed }),
      ).rejects.toThrow(/approval|ceiling/i);
    }
    expect((await inspectStudyBudget(root, request.study)).reservations).toHaveLength(1);
  });

  it.each(["reservation", "projection", "entire-ledger"])(
    "refuses to infer available allocation from missing %s evidence",
    async (missing) => {
      await reserveStudyBudget(root, request);
      const ledger = join(root, ".visp-runner", "studies", request.study);
      if (missing === "entire-ledger") await rm(join(root, ".visp-runner"), { recursive: true });
      else
        await unlink(
          join(
            ledger,
            missing === "reservation" ? "reservations/00000001.json" : "projection.json",
          ),
        );
      await expect(reserveStudyBudget(root, { ...request, runId: "run-two" })).rejects.toThrow(
        /missing|incomplete|integrity/i,
      );
    },
  );

  it("counts decimal allocations exactly and rounds tiny requests conservatively", async () => {
    for (let index = 0; index < 3; index += 1) {
      await reserveStudyBudget(root, {
        ...request,
        runId: `decimal-${index}`,
        studyMaxEstimatedUsd: 0.3,
        maxEstimatedUsd: 0.1,
      });
    }
    const budget = await inspectStudyBudget(root, request.study);
    expect(budget.allocatedMicroUsd).toBe("300000");
    expect(budget.remainingMicroUsd).toBe("0");
    await expect(
      reserveStudyBudget(root, {
        ...request,
        runId: "decimal-overflow",
        studyMaxEstimatedUsd: 0.3,
        maxEstimatedUsd: 0.0000001,
      }),
    ).rejects.toThrow(/exhausted/i);
    const tiny = await reserveStudyBudget(root, {
      ...request,
      study: "tiny-study",
      runId: "tiny-request",
      studyMaxEstimatedUsd: 0.0000015,
      maxEstimatedUsd: 0.0000001,
    });
    expect(tiny.allocatedMicroUsd).toBe("1");
    expect((await inspectStudyBudget(root, "tiny-study")).remainingMicroUsd).toBe("0");
  });

  it("rejects malformed retained reservation evidence without replacing it", async () => {
    await reserveStudyBudget(root, request);
    await writeFile(
      join(root, ".visp-runner", "studies", request.study, "reservations", "00000001.json"),
      "{incomplete",
    );
    await expect(inspectStudyBudget(root, request.study)).rejects.toThrow(/malformed/i);
    await expect(reserveStudyBudget(root, { ...request, runId: "run-two" })).rejects.toThrow(
      /malformed/i,
    );
  });

  it("requires a positive approved total at least as large as the attempt maximum", async () => {
    await expect(
      reserveStudyBudget(root, { ...request, studyMaxEstimatedUsd: 0.5 }),
    ).rejects.toThrow(/attempt|maximum/i);
  });
});
