import { afterEach, describe, expect, it } from "vitest";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());
describe("domain-neutral reliability through the built CLI", () => {
  it("accepts meaningful assertions inside an indirect helper without demanding facade artifacts", async () => {
    const prepared = await productProject();
    project = prepared.project;
    succeeded(project, "work");
    await project.write("src/value.mjs", "export const value = 2;");
    await project.write(
      "tests/helpers.mjs",
      "import assert from 'node:assert/strict';export const verifyValue = value => assert.equal(value,2);",
    );
    await project.write(
      "tests/value.test.mjs",
      "import test from 'node:test';import {value} from '../src/value.mjs';import {verifyValue} from './helpers.mjs';test('public value',()=>verifyValue(value));",
    );
    const done = project.json<{ closed: boolean }>("done");
    expect(done.result.exitCode, done.result.stdout).toBe(0);
    expect(done.envelope.data?.closed).toBe(true);
    expect(project.git("ls-files", "--others", "--exclude-standard", "src")).toBe("");
  });
  it("detects a broken result through the same indirect helper", async () => {
    const prepared = await productProject();
    project = prepared.project;
    succeeded(project, "work");
    await project.write("src/value.mjs", "export const value = 1000;");
    await project.write(
      "tests/helpers.mjs",
      "import assert from 'node:assert/strict';export const verifyValue = value => assert.equal(value,2);",
    );
    await project.write(
      "tests/value.test.mjs",
      "import test from 'node:test';import {value} from '../src/value.mjs';import {verifyValue} from './helpers.mjs';test('public value',()=>verifyValue(value));",
    );
    const done = project.json<{ closed: boolean; executions: { status: string }[] }>("done");
    expect(done.result.exitCode).not.toBe(0);
    expect(done.envelope.data?.closed).toBe(false);
    expect(done.envelope.data?.executions[0]?.status).toBe("failed");
  });
});
