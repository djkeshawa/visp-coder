import { posix } from "node:path";
import type { ProjectFileSystem } from "../../core/fs.js";
import type { Finding } from "../artifacts/evidence.js";
import { inspectTestSource, type TestInspection } from "./test-inspection.js";

/** Inspect reachable support for contradictions, never merge its cases into the entry point. */
export async function browserDependencyFindings(
  files: ProjectFileSystem,
  path: string,
  inspection: TestInspection,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const queue = [{ path, inspection }];
  const seen = new Set([path]);
  for (let index = 0; index < queue.length && index < 32; index++) {
    const entry = queue[index];
    if (!entry) break;
    for (const base of unseenImports(entry, seen)) {
      if (seen.size > 64)
        return [
          ...findings,
          unresolved(path, "The support import graph exceeds bounded inspection"),
        ];
      const result = await inspectSupportModule(files, base);
      findings.push(...result.findings);
      if (result.module) queue.push(result.module);
    }
  }
  if (queue.length > 32)
    findings.push(unresolved(path, "The support import graph exceeds bounded inspection"));
  return findings;
}

function unseenImports(
  entry: { path: string; inspection: TestInspection },
  seen: Set<string>,
): string[] {
  const paths: string[] = [];
  for (const source of entry.inspection.localModuleSources ?? []) {
    const base = posix.normalize(posix.join(posix.dirname(entry.path), source));
    if (seen.has(base)) continue;
    seen.add(base);
    paths.push(base);
    if (seen.size > 64) break;
  }
  return paths;
}

async function inspectSupportModule(files: ProjectFileSystem, base: string) {
  const resolved = await readModule(files, base);
  if (!resolved) return { findings: [unresolved(base, "Support import could not be inspected")] };
  const inspection = await inspectTestSource(resolved.path, resolved.source);
  const findings = [...(inspection.browserFindings ?? [])];
  if (inspection.uncertainty) findings.push(unresolved(resolved.path, inspection.uncertainty));
  return { findings, module: { path: resolved.path, inspection } };
}

async function readModule(files: ProjectFileSystem, base: string) {
  if (base.startsWith("../") || posix.isAbsolute(base)) return undefined;
  const candidates = posix.extname(base)
    ? [base]
    : [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}/index.js`];
  for (const path of candidates) {
    const result = await files.readTextIfExists(path);
    if (result.ok && result.value !== undefined) return { path, source: result.value };
  }
  return undefined;
}

function unresolved(path: string, reason: string): Finding {
  return {
    code: "validation-browser-support-unassessed",
    severity: "warning",
    path,
    message: `${path}: ${reason}`,
    recommendation:
      "Inspect the runner's actual support path and preserve execution reports; support declarations alone cannot establish coverage.",
  };
}
