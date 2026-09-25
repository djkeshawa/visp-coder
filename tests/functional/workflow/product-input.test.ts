import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { productCheckSchema } from "../../../src/workflow/product/model.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());

function stdin(input: unknown, ...args: string[]) {
  if (!project) throw new Error("Missing fixture");
  const result = spawnSync(
    process.execPath,
    [resolve("dist/cli.js"), "--project", project.root, ...args, "--json"],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      cwd: project.root,
      env: project.env(),
      timeout: 15_000,
    },
  );
  return { ...result, envelope: JSON.parse(result.stdout) };
}

it("finishes through editable input streams with no authored review or draft file", async () => {
  ({ project } = await productProject());
  const before = await readdir(project.root);
  const brief = JSON.parse(succeeded(project, "brief", "--template"));
  expect(stdin(brief, "brief", "--from", "-", "--reason", "Keep the current intent").status).toBe(
    0,
  );
  succeeded(project, "work");
  await project.write("src/value.mjs", "export const value = 2;");
  succeeded(project, "done");
  const template = JSON.parse(succeeded(project, "review", "--template"));
  for (const row of template.assessments) {
    row.status = "satisfied";
    row.summary = "The executed public-module test observes the required value of two.";
    row.evidence = ["C001"];
  }
  template.feedback = moduleFeedback(JSON.parse(succeeded(project, "review")));
  const submitted = stdin(template, "review", "--from", "-");
  expect(submitted.status, submitted.stderr + submitted.stdout).toBe(0);
  succeeded(project, "accept");
  expect(project.json<{ action: string }>("next").envelope.data?.action).toBe("complete");
  expect(await readdir(project.root)).toEqual(before);
  await expect(stat(resolve(project.root, ".visp/drafts"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const concise = succeeded(project, "status");
  const complete = project.run("status", "--json").stdout;
  expect(concise.length).toBeLessThan(complete.length / 2);
});

it("feeds capture and control stdin through their real validators without executing invalid input", async () => {
  ({ project } = await productProject());
  for (const operation of ["capture", "control"]) {
    const result = stdin({}, operation, "--from", "-");
    expect(result.status).not.toBe(0);
    expect(result.envelope.error.code).toBe("CONFIG_INVALID");
  }
});

it("accepts capture replay syntax and rejects conflicting inputs through the shared validator", async () => {
  ({ project } = await productProject());
  const missing = project.json("capture", "--task", "T001", "--replay", "missing");
  expect(missing.envelope).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
  const conflicting = stdin(
    { url: "http://127.0.0.1/" },
    "capture",
    "--from",
    "-",
    "--replay",
    "missing",
  );
  expect(conflicting.envelope).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
});

it("delivers read-only check templates through the CLI and rejects conflicting authoring modes", async () => {
  ({ project } = await productProject());
  const before = succeeded(project, "brief", "--template");
  for (const kind of ["command", "browser"]) {
    const output = JSON.parse(succeeded(project, "brief", "--check-template", kind));
    expect(productCheckSchema.safeParse({ id: "C099", ...output.example }).success).toBe(true);
    expect(output.example.outcomes).toEqual([]);
  }
  expect(succeeded(project, "brief", "--template")).toBe(before);
  expect(project.json("brief", "--check-template", "other").envelope).toMatchObject({ ok: false });
  expect(stdin({}, "brief", "--check-template", "browser", "--from", "-").envelope).toMatchObject({
    ok: false,
    error: { code: "ARTIFACT_INVALID" },
  });
});
