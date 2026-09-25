import type { Finding } from "../artifacts/evidence.js";
import type { TestInspection } from "./test-inspection.js";

export function testSyntaxFinding(path: string, inspection: TestInspection): Finding | undefined {
  const location = inspection.syntaxError;
  if (!location) return undefined;
  return {
    code: "validation-test-syntax-invalid",
    severity: "error",
    path,
    message: `${path}:${location.line}:${location.column}: the test parser found invalid syntax near this location`,
    recommendation:
      "Correct the test syntax and rerun validation; source inspection did not execute any test cases",
  };
}
