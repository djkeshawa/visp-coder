import { parse, stringify } from "yaml";
import type { ProductBrief } from "../../../src/workflow/product/model.js";
import { TestProject } from "./project.js";

export const VALUE_SOURCE = "export const value = 1;\n";
export const VALUE_TEST =
  "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('public value is two',()=>assert.equal(value,2));\n";

export function succeeded(project: TestProject, ...args: string[]): string {
  const result = project.run(...args);
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** An actual installed project and authored brief, ready for work authorization. */
export async function productProject(
  options: {
    goal?: string;
    files?: Record<string, string>;
    definition?: Record<string, unknown>;
    allowed?: string[];
    forbidden?: string[];
  } = {},
): Promise<{ project: TestProject; feature: string }> {
  const project = await TestProject.create(
    options.files ?? { "src/value.mjs": VALUE_SOURCE, "tests/value.test.mjs": VALUE_TEST },
  );
  succeeded(project, "init", "--harness", "generic");
  // These fixtures exercise baseline product checks without requesting model review.
  const settings = parse(await project.read("visp.yml"));
  settings.critic = { ...settings.critic, enabled: false };
  await project.write("visp.yml", stringify(settings));
  succeeded(project, "install", "--hooks", "git");
  project.commit("install product workflow");
  const created = project.json<{ brief: ProductBrief }>("feature", options.goal ?? "Return two");
  if (created.result.exitCode || !created.envelope.data)
    throw new Error(created.result.stdout + created.result.stderr);
  const feature = created.envelope.data.brief.feature;
  await project.authorBrief(
    feature,
    options.definition ?? {
      outcomes: [
        {
          id: "O001",
          kind: "functional",
          statement: "The public value is two",
          priority: "must",
          provenance: "user-stated",
        },
      ],
      checks: [
        {
          id: "C001",
          command: [process.execPath, "--test", "tests/value.test.mjs"],
          outcomes: ["O001"],
          files: ["src/value.mjs", "tests/value.test.mjs"],
          environment: "node",
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Return the promised value",
          outcomes: ["O001"],
          scope: {
            allowed: options.allowed ?? ["src/**", "tests/**"],
            expected: ["src/value.mjs"],
            forbidden: options.forbidden ?? [],
          },
          checks: ["C001"],
        },
      ],
    },
  );
  return { project, feature };
}
