import { type EvidenceReceipt, evidenceReceiptSchema } from "../artifacts/evidence-contract.js";

/** Agent-reported assertions parsed from stdout; never supervisor execution records. */
export function parseEvidenceReceipts(output: string): EvidenceReceipt[] {
  const receipts: EvidenceReceipt[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(?:#\s*)?VISP_EVIDENCE\s+(.*)$/.exec(line);
    if (!match) continue;
    if (line.length > 4_096 || receipts.length >= 256)
      throw new Error("Evidence receipt limit exceeded");
    receipts.push(evidenceReceiptSchema.parse(JSON.parse(match[1] ?? "")));
  }
  return receipts;
}
