import type { ProductBrief, ProductCheck } from "./model.js";

/** Use the pinned declarations for execution and correction ownership alike. */
export function pinnedAcceptanceChecks(brief: ProductBrief): ProductCheck[] {
  return brief.acceptanceBaseline.map((check, index) => ({
    id: `PINNED_${index + 1}`,
    command: check.command,
    outcomes: [],
    files: check.files.map((file) => file.path),
    environment: "other",
  }));
}
