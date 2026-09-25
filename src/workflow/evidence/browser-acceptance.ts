import type { Finding } from "../artifacts/evidence.js";
import type { TestScope } from "./test-inspection.js";

export function strictBrowserFindings(findings: readonly Finding[]): Finding[] {
  return findings.map((finding) =>
    /^validation-browser-.*-unassessed$/.test(finding.code)
      ? {
          ...finding,
          severity: "error",
          recommendation: `${finding.recommendation ?? ""} Mandatory acceptance remains unchecked until this evidence gap is resolved.`,
        }
      : finding,
  );
}

export function criterionBrowserFindings(
  scope: TestScope & { path: string },
  outputSurface?: string,
): Finding[] {
  const findings: Finding[] = [];
  if (
    (outputSurface === "canvas" || outputSurface === "webgl") &&
    !scope.browserActions?.pixelOutcome
  )
    findings.push(
      problem(
        "validation-browser-output-surface-unestablished",
        scope.path,
        `No asserted post-input pixel output was attributed to this ${outputSurface} criterion`,
        "Assert the relevant rendered pixels or a screenshot comparison. A passing DOM counter does not establish canvas output; keep an isolated disabled-renderer negative control.",
      ),
    );
  if (scope.browserActions?.inputBypass)
    findings.push(
      problem(
        "validation-browser-input-bypass",
        scope.path,
        "Synthetic, page-evaluated, forced, or unawaited input does not establish the user's interaction path",
        "Use browser mouse, touch, or keyboard input. Keep synthetic events in handler tests, not mandatory journey evidence.",
      ),
    );
  if (!scope.browserActions?.renderedOutcome)
    findings.push(
      problem(
        "validation-browser-outcome-unestablished",
        scope.path,
        "No rendered outcome assertion could be attributed to the final interaction",
        "Assert a post-action rendered result in this case. Attributes, an already-true flag, and a separate internal calculation do not establish the promised journey.",
      ),
    );
  return findings;
}

export function untracedBrowserCriterion(criterion: string, path?: string): Finding {
  return problem(
    "validation-browser-criterion-untraced",
    path,
    `No selected named browser case owns ${criterion}`,
    `Include ${criterion} in its actual test name, exercise its production interaction, assert the resulting state, and emit VISP_ASSERT ${criterion} passed only after the assertion succeeds. A command alias or printed receipt alone is insufficient.`,
  );
}

function problem(
  code: string,
  path: string | undefined,
  message: string,
  recommendation: string,
): Finding {
  return { code, path, message, recommendation, severity: "error" };
}
