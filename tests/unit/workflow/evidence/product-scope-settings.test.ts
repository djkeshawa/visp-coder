import { readFile, symlink } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { runJson } from "../../cli/support/cli.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let project: TestWorkspace | undefined;
afterEach(async () => project?.destroy());

it.each([
  { limit: 1, policyLimit: undefined, refused: true },
  { limit: 2, policyLimit: undefined, refused: false },
  { limit: 1, policyLimit: 2, refused: false },
  { limit: 2, policyLimit: 1, refused: true },
])(
  "enforces the authored limit and recorded policy precedence: %j",
  async ({ limit, policyLimit, refused }) => {
    ({ workspace: project } = await productWorkspace());
    const initial = await project.state();
    const config = parse(await readFile(initial.paths.config, "utf8"));
    config.workflow.maxChangedFiles = limit;
    await project.write("visp.yml", stringify(config));
    if (policyLimit !== undefined)
      await project.write(
        ".visp/policy.json",
        JSON.stringify({ ...initial.policy, maxChangedFiles: policyLimit }),
      );
    expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
    await project.write("src/value.mjs", "export const value = 2;\n");
    const test = await readFile(`${project.root}/test/value.test.mjs`, "utf8");
    await project.write("test/value.test.mjs", `${test}\n// Also changed within declared scope.\n`);
    const result = await runJson<{ passed: boolean }>(project.root, "verify", "--task", "T001");
    if (refused) {
      expect(result.envelope).toMatchObject({
        ok: false,
        error: { code: "SCOPE_VIOLATION" },
      });
      expect(result.envelope.error?.message).toContain(
        "Changed-file count 2 exceeds configured limit 1",
      );
    } else {
      expect(result.envelope).toMatchObject({
        ok: true,
        data: { passed: true },
      });
    }
  },
);

it.each([true, false])(
  "enforces an authored blocked path even within the slice: blocked=%s",
  async (blocked) => {
    ({ workspace: project } = await productWorkspace());
    const initial = await project.state();
    const config = parse(await readFile(initial.paths.config, "utf8"));
    if (blocked) config.workflow.blockedPaths.push("src/value.mjs");
    await project.write("visp.yml", stringify(config));
    expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
    await project.write("src/value.mjs", "export const value = 2;\n");
    const result = await runJson<{ passed: boolean }>(project.root, "verify", "--task", "T001");
    expect(result.envelope).toMatchObject(
      blocked
        ? {
            ok: false,
            error: {
              code: "SCOPE_VIOLATION",
              details: { forbidden: ["src/value.mjs"] },
            },
          }
        : { ok: true, data: { passed: true } },
    );
  },
);

it("honors a recorded changed-file override during verify", async () => {
  ({ workspace: project } = await productWorkspace());
  const initial = await project.state();
  const config = parse(await readFile(initial.paths.config, "utf8"));
  config.workflow.maxChangedFiles = 1;
  await project.write("visp.yml", stringify(config));
  expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
  const override = await runJson(
    project.root,
    "override",
    "create",
    "scope.max-changed-files",
    "--reason",
    "Two files are needed for this tested change",
  );
  expect(override.exitCode).toBe(0);
  await project.write("src/value.mjs", "export const value = 2;\n");
  const test = await readFile(`${project.root}/test/value.test.mjs`, "utf8");
  await project.write("test/value.test.mjs", `${test}\n// Still checks the value.\n`);
  expect((await runJson(project.root, "verify", "--task", "T001")).envelope.error?.code).not.toBe(
    "SCOPE_VIOLATION",
  );
});

it("refuses a VISP config edit even when the slice scope is widened", async () => {
  ({ workspace: project } = await productWorkspace());
  expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
  const result = await runJson(project.root, "guard", "--path", "visp.yml");
  expect(result.envelope.data).toMatchObject({ violations: [{ reason: "protected-path" }] });
});

it("keeps the blocked-path list from authorization after visp.yml is tampered with", async () => {
  ({ workspace: project } = await productWorkspace());
  expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
  const configPath = `${project.root}/visp.yml`;
  const config = parse(await readFile(configPath, "utf8"));
  config.workflow.blockedPaths = [];
  await project.write("visp.yml", stringify(config));
  const guard = await runJson<{ violations: { reason: string }[] }>(
    project.root,
    "guard",
    "--path",
    ".env",
  );
  expect(guard.envelope.data?.violations[0]?.reason).toBe("blocked-path");
  const verified = await runJson(project.root, "verify", "--task", "T001");
  expect(verified.envelope.error?.code).toBe("SCOPE_VIOLATION");
});

it("uses relaxed allowed-files policy in both guard and verify", async () => {
  ({ workspace: project } = await productWorkspace());
  const state = await project.state();
  await project.write(
    ".visp/policy.json",
    JSON.stringify({ ...state.policy, strictness: "relaxed" }),
  );
  expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
  await project.write("notes/extra.md", "A permitted extra note.\n");
  expect(
    (await runJson(project.root, "guard", "--path", "notes/extra.md")).envelope.data,
  ).toMatchObject({ allowed: true });
  expect((await runJson(project.root, "verify", "--task", "T001")).envelope.error?.code).not.toBe(
    "SCOPE_VIOLATION",
  );
});

it("detects an ignored nested environment file created after authorization", async () => {
  ({ workspace: project } = await productWorkspace());
  expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
  await project.write("apps/api/.env", "SECRET=fixture\n");
  const checked = await runJson(project.root, "verify", "--task", "T001");
  expect(checked.envelope.error).toMatchObject({
    code: "SCOPE_VIOLATION",
    details: { forbidden: ["apps/api/.env"] },
  });
});

it("hashes a repository symlink as a link and catches changes to its blocked target", async () => {
  ({ workspace: project } = await productWorkspace());
  await project.write(".env", "SECRET=old\n");
  await symlink("../.env", `${project.root}/src/settings.env`);
  project.commit("existing link and environment baseline");
  expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
  const before = await productSourceSnapshot(await project.state());
  expect(before.ok).toBe(true);
  await project.write(".env", "SECRET=new\n");
  const after = await productSourceSnapshot(await project.state());
  expect(after.ok && before.ok && after.value["src/settings.env"]).toBe(
    before.ok && before.value["src/settings.env"],
  );
  const checked = await runJson(project.root, "verify", "--task", "T001");
  expect(checked.envelope.error?.code).toBe("SCOPE_VIOLATION");
});
