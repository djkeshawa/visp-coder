import { ProjectFileSystem } from "../../core/fs.js";
import type { Finding } from "../artifacts/evidence.js";
import { criterionBrowserFindings, untracedBrowserCriterion } from "./browser-acceptance.js";
import { browserDependencyFindings } from "./browser-dependencies.js";
import { inspectTestSource, type TestInspection, type TestScope } from "./test-inspection.js";
import { testSyntaxFinding } from "./test-syntax.js";

interface BrowserOptions {
  readonly acceptanceCriterion?: string;
  readonly outputSurface?: string;
  readonly strictEvidence?: boolean;
  readonly requireLayout: boolean;
  readonly scenarioIds: readonly string[];
}

interface LocatedScope extends TestScope {
  readonly path: string;
  readonly customRegistration?: boolean;
}

const INTERACTION_PATTERN =
  /\b(?:click|dblclick|fill|press|type|dragTo|tap|check|uncheck|selectOption|dispatchEvent)\s*\(|\b(?:mouse|keyboard|touchscreen)\s*\./g;
const ASSERTION_PATTERN = /\b(?:expect|assert)(?:\.|\s*\()/;
const STATE_BYPASS_PATTERN =
  /\b(?:window|globalThis)\s*\.\s*__[A-Za-z_$][\w$]*\s*\.\s*(?:demo|force|inject|spawn|advance|complete|win|lose|score|damage|upgrade|boss|wave|gameOver|setState|setScore|setWave)\s*\(/i;

/** Each named case owns its contract. Unrelated cases/files cannot supply missing steps. */
export async function inspectBrowserContract(
  root: string,
  paths: readonly string[],
  argv: readonly string[],
  options: BrowserOptions,
  files = new ProjectFileSystem(root),
): Promise<Finding[]> {
  const { scopes, findings, readable, launchers } = await readScopes(files, paths);
  if (findings.some((finding) => finding.code === "validation-test-syntax-invalid"))
    return findings;
  if (readable === 0) return [uninspectable(argv)];
  if (scopes.length === 0 && launchers.length > 0) {
    return [
      ...findings,
      unassessed(
        launchers[0],
        "The custom runner launches another process; inspect its executed-case report and dispatch before claiming scenario coverage",
      ),
    ];
  }
  if (scopes.length === 0) return [...findings, uninspectable(argv)];

  const selected = selectScopes(scopes, argv);
  if (typeof selected === "string") return [...findings, unassessed(paths[0], selected)];
  findings.push(...acceptanceFindings(selected, options, paths[0]));
  const relevant = options.scenarioIds.length
    ? selected.filter((scope) => options.scenarioIds.some((id) => namesScenario(scope, id)))
    : selected;
  const missing = options.scenarioIds.filter(
    (id) => !selected.some((scope) => namesScenario(scope, id)),
  );
  if (missing.length && findings.length === 0) {
    findings.push({
      code: "validation-browser-scenario-untraced",
      severity: "error",
      message: `Selected browser cases do not name claimed workflow ${missing.join(", ")}`,
      path: paths[0],
      recommendation:
        "Name each SCN id in its selected test case; a different case or a skipped test cannot cover it",
    });
  }
  for (const scope of relevant.filter((scope) => !scope.customRegistration)) {
    if (scope.indirect) {
      findings.push(
        unassessed(
          scope.path,
          "Conditional dispatch or an indirect helper prevents attribution of the interaction and outcome",
        ),
      );
      continue;
    }
    findings.push(...workflowFindings(scope));
    if (options.requireLayout) findings.push(...layoutFindings(scope));
  }
  return findings;
}

function acceptanceFindings(
  selected: readonly LocatedScope[],
  options: BrowserOptions,
  path?: string,
): Finding[] {
  if (!options.acceptanceCriterion)
    return options.strictEvidence
      ? selected.flatMap((scope) => criterionBrowserFindings(scope, options.outputSurface))
      : [];
  const owners = selected.filter((scope) =>
    (scope.name?.match(/\bAC\d+\b/g) ?? []).some((id) => id === options.acceptanceCriterion),
  );
  return owners.length
    ? owners.flatMap((scope) => criterionBrowserFindings(scope, options.outputSurface))
    : [untracedBrowserCriterion(options.acceptanceCriterion, path)];
}

async function readScopes(files: ProjectFileSystem, paths: readonly string[]) {
  const scopes: LocatedScope[] = [];
  const findings: Finding[] = [];
  const launchers: string[] = [];
  let readable = 0;
  for (const path of paths) {
    const source = await files.readTextIfExists(path);
    if (!source.ok || source.value === undefined) continue;
    readable++;
    const inspected = await inspectTestSource(path, source.value);
    findings.push(...(inspected.browserFindings ?? []));
    findings.push(...(await browserDependencyFindings(files, path, inspected)));
    const syntax = testSyntaxFinding(path, inspected);
    if (syntax) {
      findings.push(syntax);
      continue;
    }
    if (isOpaqueLauncher(inspected)) {
      launchers.push(path);
      continue;
    }
    if (inspected.uncertainty) findings.push(unassessed(path, inspected.uncertainty));
    const customRegistration = inspected.localTestRegistration;
    scopes.push(...inspected.scopes.map((scope) => ({ ...scope, path, customRegistration })));
  }
  return { scopes, findings, readable, launchers };
}

function isOpaqueLauncher(inspection: TestInspection): boolean {
  return (
    inspection.hasDynamicExecutor &&
    !inspection.uncertainty &&
    inspection.scopes.every((scope) => scope.name === undefined) &&
    !/\b(?:goto|setContent)\s*\(/.test(inspection.code)
  );
}

function namesScenario(scope: TestScope, id: string): boolean {
  return (scope.text.match(/\bSCN\d+\b/g) ?? []).some((found) => found === id);
}

function selectScopes(
  scopes: readonly LocatedScope[],
  argv: readonly string[],
): LocatedScope[] | string {
  if (argv.some((argument) => /^(?:--case|--mode)(?:=|$)/.test(argument)))
    return "Custom case dispatch is not a supported test-name selector; source inspection cannot determine which callbacks execute";
  let selected = scopes.some((scope) => scope.exclusive)
    ? scopes.filter((scope) => scope.exclusive)
    : [...scopes];
  for (let index = 0; index < argv.length; index++) {
    const [flag, inline] = (argv[index] ?? "").split(/=(.*)/s);
    if (
      !["--grep", "-g", "--grep-invert", "--test-name-pattern", "--testNamePattern", "-t"].includes(
        flag ?? "",
      )
    )
      continue;
    const expression = inline ?? argv[++index];
    if (!expression) return "The test selector has no pattern";
    try {
      const pattern = new RegExp(expression);
      selected = selected.filter(
        (scope) =>
          scope.name !== undefined && pattern.test(scope.name) !== (flag === "--grep-invert"),
      );
    } catch {
      return "The test selector could not be interpreted";
    }
  }
  return selected;
}

function workflowFindings(scope: LocatedScope): Finding[] {
  const source = scope.code;
  const missing: string[] = [];
  if (!/\b(?:goto|setContent)\s*\(/.test(source)) missing.push("navigation");
  const actions = [...source.matchAll(INTERACTION_PATTERN)];
  if (actions.length === 0 && !scope.browserActions?.hasInput) missing.push("a user interaction");
  if (!ASSERTION_PATTERN.test(source) && !scope.browserActions?.uiCheck)
    missing.push("an assertion");
  const findings: Finding[] = missing.length
    ? [
        {
          code: "validation-browser-workflow-incomplete",
          severity: "error",
          message: `${scope.name ?? scope.path} has no direct ${missing.join(", ")} in this browser case`,
          path: scope.path,
          recommendation:
            "Navigate, perform the production interaction, and assert the downstream result in the same selected case",
        },
      ]
    : [];
  const first = actions[0];
  if (first && !ASSERTION_PATTERN.test(source.slice(first.index + first[0].length))) {
    findings.push({
      code: "validation-browser-outcome-unasserted",
      severity: "error",
      message: `${scope.name ?? scope.path} has no assertion after an interaction in this case`,
      path: scope.path,
      recommendation:
        "Assert the resulting state after the action, not only its precondition or another scenario's result",
    });
  }
  if (STATE_BYPASS_PATTERN.test(source)) {
    findings.push({
      code: "validation-browser-state-bypass",
      severity: "error",
      message: `${scope.name ?? scope.path} reaches the claimed outcome through a test-only state seam`,
      path: scope.path,
      recommendation:
        "Use internal seams for unit or integration setup only; functional evidence must reach the state through production controls and assert its observable result",
    });
  }
  return findings;
}

function layoutFindings(scope: LocatedScope): Finding[] {
  if (scope.browserActions?.uiCheck) return [];
  const source = scope.code;
  const missing: string[] = [];
  if (!/\b(?:setViewportSize|setViewport|viewport\s*[:=(]|innerWidth|resizeTo)\b/.test(source))
    missing.push("a representative viewport");
  if (
    !/\b(?:scrollWidth|scrollHeight)\b/.test(source) ||
    !/\b(?:clientWidth|clientHeight|innerWidth|innerHeight)\b/.test(source)
  )
    missing.push("an overflow or viewport-fit assertion");
  if (
    !/\b(?:toBeVisible|isVisible|getBoundingClientRect|boundingBox)\b/.test(source) ||
    !ASSERTION_PATTERN.test(source)
  )
    missing.push("an essential-control visibility assertion");
  return missing.length
    ? [
        {
          code: "validation-browser-contract-incomplete",
          severity: "error",
          message: `${scope.name ?? scope.path} does not mechanically check ${missing.join(", ")}`,
          path: scope.path,
          recommendation:
            "Exercise a representative viewport and assert document fit and essential control visibility within this case",
        },
      ]
    : [];
}

function unassessed(path: string | undefined, reason: string): Finding {
  return {
    code: "validation-browser-path-unassessed",
    severity: "warning",
    message: `${path ?? "Browser validation"}: ${reason}; source inspection did not establish scenario coverage`,
    path,
    recommendation:
      "Use focused named cases or inspect the actual runner trace; command success alone does not establish the claimed interaction",
  };
}

function uninspectable(argv: readonly string[]): Finding {
  return {
    code: "validation-browser-contract-uninspectable",
    severity: "error",
    message: `${argv.join(" ")} names browser evidence but no inspectable validation case was declared`,
    recommendation:
      "Name a selected JavaScript or TypeScript browser test in validationFiles so Visp can inspect its contract and preserve it during flip",
  };
}
