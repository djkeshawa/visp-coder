import { posix } from "node:path";
import { type CommandSpec, resolveCommand } from "../../core/exec.js";
import { ProjectFileSystem } from "../../core/fs.js";
import { repositoryFiles } from "../../core/git.js";
import { matchesAny } from "../../core/patterns.js";
import { resolveScriptImport } from "../../graph/extract/resolve.js";
import type { ValidationLayer } from "../artifacts/common.js";
import { namesBrowserRunner } from "../artifacts/criteria.js";
import type { Finding } from "../artifacts/evidence.js";
import type { EngineeringConcern } from "../artifacts/tasks.js";
import { isTestFile } from "../module-paths.js";
import { strictBrowserFindings } from "./browser-acceptance.js";
import { inspectBrowserContract } from "./browser-quality.js";
import {
  browserObservationMode,
  nonExecutingValidationMode,
  staticInspectionCommand,
  syntaxOnlyValidationMode,
} from "./command-quality.js";
import { inspectTestSource, sourceEvidenceKind, type TestInspection } from "./test-inspection.js";
import { testSyntaxFinding } from "./test-syntax.js";

export interface LayeredCommand {
  readonly command: CommandSpec;
  readonly layer?: ValidationLayer;
}

export interface ValidationQualityOptions {
  /** Final acceptance requires a selected criterion-owned case, not command success alone. */
  readonly acceptanceCriterion?: string;
  readonly outputSurface?: string;
  readonly strictBrowserEvidence?: boolean;
  readonly concerns?: readonly EngineeringConcern[];
  readonly validationFiles?: readonly string[];
  /** Workflow scenarios this task's functional evidence claims to settle. */
  readonly scenarioIds?: readonly string[];
  /** Layers required by accepted criteria or the engineering plan. */
  readonly requiredLayers?: readonly ValidationLayer[];
}

/** A claimed layer must execute the boundary it names, not merely resemble it. */
export async function inspectValidationQuality(
  root: string,
  checks: readonly LayeredCommand[],
  options: ValidationQualityOptions = {},
): Promise<Finding[]> {
  const files = new ProjectFileSystem(root);
  const findings: Finding[] = [];
  const declaredValidationFiles = await matchingValidationFiles(
    root,
    options.validationFiles ?? [],
  );
  for (const check of checks) {
    const resolved = resolveCommand(check.command);
    if (!resolved.ok) continue;
    const nonExecutingMode = nonExecutingValidationMode(resolved.value);
    const syntaxOnlyMode = syntaxOnlyValidationMode(resolved.value);
    if (nonExecutingMode || syntaxOnlyMode) {
      findings.push({
        code: "validation-command-no-evidence",
        severity: "error",
        message: `${resolved.value.join(" ")} uses ${nonExecutingMode ?? syntaxOnlyMode}, which does not execute project behavior`,
        recommendation:
          "Run a focused test or workflow that exercises the changed behavior and fails when that behavior is wrong",
      });
      continue;
    }
    const staticCommand = staticInspectionCommand(resolved.value);
    if (check.layer && check.layer !== "static" && staticCommand) {
      findings.push({
        code: "validation-layer-static-only",
        severity: "error",
        message: `${resolved.value.join(" ")} inspects source text or file shape, so it is not ${check.layer} evidence`,
        recommendation:
          "Label the command static, then add a focused check that executes the claimed behavior or boundary",
      });
      continue;
    }
    const testFiles = commandTestFiles(check.command);
    findings.push(
      ...(await inspectFunctionalQuality(
        root,
        files,
        check,
        resolved.value,
        testFiles,
        declaredValidationFiles,
        options,
      )),
    );
    findings.push(...(await inspectSelectorQuality(files, resolved.value, testFiles)));
    findings.push(
      ...(await inspectExecutionLayer(root, files, check, testFiles, options.requiredLayers ?? [])),
    );
  }
  return dedupeFindings(
    options.acceptanceCriterion || options.strictBrowserEvidence
      ? strictBrowserFindings(findings)
      : findings,
  );
}

async function inspectFunctionalQuality(
  root: string,
  files: ProjectFileSystem,
  check: LayeredCommand,
  argv: readonly string[],
  testFiles: readonly string[],
  declaredValidationFiles: readonly string[],
  options: ValidationQualityOptions,
): Promise<Finding[]> {
  if (
    check.layer !== "functional" &&
    !options.acceptanceCriterion &&
    !options.strictBrowserEvidence
  )
    return [];
  const findings: Finding[] = [];
  if (isObservationOnly(argv)) {
    findings.push({
      code: "validation-functional-observation-only",
      severity: "error",
      message: `${argv.join(" ")} captures an observation but performs no interaction assertion`,
      recommendation:
        "Keep the screenshot as advisory evidence, then add a functional command that performs the workflow and asserts its resulting state",
    });
  }
  const browserConcerns = new Set(options.concerns ?? []);
  if (namesBrowserRunner(argv.join(" "))) {
    const sources = [...new Set(testFiles.length > 0 ? testFiles : declaredValidationFiles)];
    findings.push(
      ...(await inspectBrowserContract(
        root,
        sources,
        argv,
        {
          requireLayout: browserConcerns.has("visible-output"),
          scenarioIds: options.scenarioIds ?? [],
          acceptanceCriterion: options.acceptanceCriterion,
          outputSurface: options.outputSurface,
          strictEvidence: options.strictBrowserEvidence,
        },
        files,
      )),
    );
  }
  return findings;
}

async function inspectSelectorQuality(
  files: ProjectFileSystem,
  argv: readonly string[],
  testFiles: readonly string[],
): Promise<Finding[]> {
  const selector = testNameSelector(argv);
  return selector && testFiles.length > 0 ? inspectNamedSelector(files, testFiles, selector) : [];
}

async function inspectExecutionLayer(
  root: string,
  files: ProjectFileSystem,
  check: LayeredCommand,
  testFiles: readonly string[],
  requiredLayers: readonly ValidationLayer[],
): Promise<Finding[]> {
  if (!check.layer || check.layer === "static") return [];
  const findings: Finding[] = [];
  for (const path of testFiles) {
    const source = await files.readTextIfExists(path);
    if (!source.ok || source.value === undefined) continue;
    const inspected = await inspectTestSource(path, source.value);
    const syntax = testSyntaxFinding(path, inspected);
    if (syntax) {
      findings.push(syntax);
      continue;
    }
    const kind = sourceEvidenceKind(
      await resolveImplementationBindings(root, files, path, inspected),
    );
    if (!kind) continue;
    if (kind === "unassessed") {
      findings.push(
        unassessedLayerFinding(path, check.layer, enforcedLayers(check, requiredLayers)),
      );
      continue;
    }
    findings.push({
      code: "validation-layer-static-only",
      severity: "error",
      message: `${path} reads source text instead of executing project behavior, so it is not ${check.layer} evidence`,
      path,
      recommendation:
        "Label this check static, then add a focused test that imports and executes the domain or connector behavior",
    });
  }
  return findings;
}

function enforcedLayers(
  check: LayeredCommand,
  required: readonly ValidationLayer[],
): readonly ValidationLayer[] {
  return check.layer === "functional" && namesBrowserRunner(JSON.stringify(check.command))
    ? []
    : required;
}

async function resolveImplementationBindings(
  root: string,
  files: ProjectFileSystem,
  path: string,
  inspection: TestInspection,
): Promise<TestInspection> {
  const bindings: string[] = [];
  if (!inspection.projectImports.length) return inspection;
  const known = await repositoryFiles(root);
  const context = {
    files: new Set(known.ok ? known.value : []),
    aliases: { aliases: [], problems: [] },
  };
  for (const imported of inspection.projectImports.slice(0, 64)) {
    const resolved = resolveScriptImport(context, path, imported.source);
    if (resolved.kind !== "file") continue;
    const target = resolved.path;
    // Validation code cannot establish that implementation ran. Reads also reject symlinks
    // and paths outside this repository; unresolved imports remain unassessed.
    if (isTestFile(target) || posix.normalize(target) === posix.normalize(path)) continue;
    const source = await files.readTextIfExists(target);
    if (source.ok && source.value !== undefined) bindings.push(...imported.bindings);
  }
  return { ...inspection, projectBindings: bindings };
}

function unassessedLayerFinding(
  path: string,
  layer: "unit" | "integration" | "functional",
  requiredLayers: readonly ValidationLayer[],
): Finding {
  const required = requiredLayers.includes(layer);
  return {
    code: required ? "validation-layer-unestablished" : "validation-layer-unassessed",
    severity: required ? "error" : "warning",
    message: `${path}: source inspection could not establish which project behavior the ${layer} check executes`,
    path,
    recommendation:
      "Inspect the executed test path; an import or dynamic executor is not by itself proof of behavioral coverage",
  };
}

async function matchingValidationFiles(
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const files = await repositoryFiles(root);
  if (!files.ok) return [];
  // `validationFiles` is the task author's explicit declaration of support
  // code. It may name a convention-free runner or helper, so do not apply the
  // filename heuristics used for command arguments a second time.
  return files.value.filter((path) => matchesAny(path, patterns));
}

function isObservationOnly(argv: readonly string[]): boolean {
  return browserObservationMode(argv) !== undefined;
}

function testNameSelector(argv: readonly string[]): string | undefined {
  const supportsNamedSelection =
    argv.includes("--test") ||
    argv.some((argument) => /(?:^|\/)(?:jest|vitest|mocha)(?:\.m?js)?$/i.test(argument));
  if (!supportsNamedSelection) return undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    const inline = /^(?:--test-name-pattern|--testNamePattern|-t)=(.+)$/.exec(argument);
    if (inline?.[1]) return inline[1];
    if (["--test-name-pattern", "--testNamePattern", "-t"].includes(argument)) {
      const value = argv[index + 1];
      if (value) return value;
    }
  }
  return undefined;
}

async function inspectNamedSelector(
  files: ProjectFileSystem,
  paths: readonly string[],
  selector: string,
): Promise<Finding[]> {
  const readable: Array<{ path: string; names: string[] }> = [];
  for (const path of paths) {
    const source = await files.readTextIfExists(path);
    if (!source.ok || source.value === undefined) continue;
    readable.push({ path, names: namedTests(source.value) });
  }
  if (readable.length === 0) return [];

  const names = readable.flatMap((entry) => entry.names);
  if (names.length === 0) {
    return [
      {
        code: "validation-selector-no-named-tests",
        severity: "error",
        message: `${readable.map((entry) => entry.path).join(", ")} uses a named-test selector but declares no named test`,
        path: readable[0]?.path,
        recommendation:
          "Wrap each behavior in an explicitly named test so the selector proves which case ran",
      },
    ];
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(selector);
  } catch {
    return [
      {
        code: "validation-selector-invalid",
        severity: "error",
        message: `The test-name selector is not a valid regular expression: ${selector}`,
        recommendation: "Use a valid test-name pattern that matches an explicitly named test",
      },
    ];
  }
  if (names.some((name) => pattern.test(name))) return [];

  return [
    {
      code: "validation-selector-misses-tests",
      severity: "error",
      message: `The selector ${selector} matches none of the named tests in ${readable.map((entry) => entry.path).join(", ")}`,
      path: readable[0]?.path,
      recommendation: `Use one of the declared test names: ${names.slice(0, 5).join(", ")}`,
    },
  ];
}

function namedTests(source: string): string[] {
  const names: string[] = [];
  for (const quote of ['"', "'", "`"]) {
    const escaped = quote === "`" ? "`" : `\\${quote}`;
    const pattern = new RegExp(
      `\\b(?:test|it|describe)(?:\\.[A-Za-z]+)?\\s*\\(\\s*${escaped}([^${escaped}\\n]+)${escaped}`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      if (match[1]) names.push(match[1]);
    }
  }
  return names;
}

function commandTestFiles(command: CommandSpec): string[] {
  const resolved = resolveCommand(command);
  if (!resolved.ok) return [];
  return resolved.value
    .slice(1)
    .map(normalizeArgument)
    .filter((path): path is string => path !== undefined && isTestLike(path));
}

function normalizeArgument(argument: string): string | undefined {
  if (argument.startsWith("-") || argument.includes("*") || argument.includes("?"))
    return undefined;
  const path = argument.replace(/^\.\//, "");
  return path.includes("/") || /\.[cm]?[jt]sx?$/i.test(path) ? posix.normalize(path) : undefined;
}

function isTestLike(path: string): boolean {
  return isTestFile(path) || /\.[cm]?[jt]sx?$/i.test(path);
}

function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}:${finding.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
