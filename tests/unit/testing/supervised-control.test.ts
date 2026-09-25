import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSupervisedControl } from "../../../src/testing/supervised-control.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-control-test-"));
  await Promise.all([mkdir(join(root, "baseline")), mkdir(join(root, "changed"))]);
  await writeFile(join(root, "baseline/model.cjs"), "module.exports={position:10};");
  await writeFile(join(root, "changed/model.cjs"), "module.exports={position:1000};");
  await writeFile(
    join(root, "verifier.cjs"),
    "const assert=require('node:assert/strict');assert.equal(require(process.cwd()+'/model.cjs').position,10);",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const options = () => ({
  baseline: { directory: join(root, "baseline"), files: ["model.cjs"] },
  changed: { directory: join(root, "changed"), files: ["model.cjs"] },
  verifierFile: join(root, "verifier.cjs"),
  loadCommand: [process.execPath, "-e", "require('./model.cjs')"] as [string, ...string[]],
});

describe("supervised controls", () => {
  it("records actual load checks and the same verifier detecting changed behavior", async () => {
    const result = await runSupervisedControl(options());
    expect(result.detected).toBe(true);
    expect(result.provenance).toBe("supervisor-executed");
    expect(result.baseline.verification?.exitCode).toBe(0);
    expect(result.changed.verification?.exitCode).toBe(1);
    expect(result.baseline.subjectDigest).not.toBe(result.changed.subjectDigest);
  });
  it("does not credit printed booleans when the verifier passes both subjects", async () => {
    await writeFile(
      join(root, "verifier.cjs"),
      "console.log('VISP_EVIDENCE '+JSON.stringify({baselinePassed:true,changedPassed:false}));",
    );
    const result = await runSupervisedControl(options());
    expect(result.detected).toBe(false);
    expect(result.changed.verification?.exitCode).toBe(0);
  });
  it("does not mistake a load crash for detected behavior", async () => {
    await writeFile(join(root, "changed/model.cjs"), "throw Error('broken import');");
    const result = await runSupervisedControl(options());
    expect(result.detected).toBe(false);
    expect(result.changed.verification).toBeUndefined();
  });
  it("rejects shared subjects and changing verifier code", async () => {
    const input = options();
    await expect(runSupervisedControl({ ...input, changed: input.baseline })).rejects.toThrow(
      "distinct",
    );
    await writeFile(
      join(root, "verifier.cjs"),
      "require('fs').appendFileSync(__filename,'\\n// altered');",
    );
    await expect(runSupervisedControl(input)).rejects.toThrow("Verifier changed");
  });
});
