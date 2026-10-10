import { execFileSync } from "node:child_process";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import {
  checkFix,
  missingAlias,
  resolvesOnPath,
  uninstalledAlias,
} from "../../../../src/workflow/product/check-executable.js";
import { executeProductCheck } from "../../../../src/workflow/product/check-execution.js";
import { environmentNext } from "../../../../src/workflow/product/environment.js";
import { type ProductBrief, productCheckSchema } from "../../../../src/workflow/product/model.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
let brief: ProductBrief;
let bin = "";
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
beforeEach(async () => {
  ({ workspace, brief } = await productWorkspace());
  bin = join(workspace.root, ".visp", "path-fixture");
  await mkdir(bin, { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await workspace?.destroy();
  workspace = undefined;
});

async function install(name: string) {
  await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, name), 0o755);
}
/** A PATH holding git and node (VISP needs them) and only the named interpreters. */
async function pathWith(...interpreters: string[]) {
  await symlink(GIT, join(bin, "git")).catch(() => undefined);
  await symlink(process.execPath, join(bin, "node")).catch(() => undefined);
  for (const name of interpreters) await install(name);
  vi.stubEnv("PATH", bin);
}

describe("interpreter alias detection", () => {
  it("names the installed alias of an uninstalled bare interpreter", async () => {
    await install("python3");
    await install("pip3");
    expect(missingAlias("python", bin)).toBe("python3");
    expect(missingAlias("pip", bin)).toBe("pip3");
  });

  it("is silent when the name resolves, when neither exists, or for anything else", async () => {
    await install("python");
    await install("python3");
    expect(missingAlias("python", bin)).toBeUndefined();
    expect(missingAlias("python", join(bin, "elsewhere"))).toBeUndefined();
    expect(missingAlias("node", bin)).toBeUndefined();
    expect(missingAlias("/usr/bin/python", bin)).toBeUndefined();
    expect(missingAlias("./python", bin)).toBeUndefined();
    expect(resolvesOnPath("python3", bin)).toBe(true);
    expect(resolvesOnPath("ruby", bin)).toBe(false);
  });

  it("does not count a directory named like the interpreter", async () => {
    await install("python3");
    await mkdir(join(bin, "python"));
    expect(resolvesOnPath("python", bin)).toBe(false);
    expect(missingAlias("python", bin)).toBe("python3");
  });

  it("builds the brief patch in the form the check used", () => {
    const check = productCheckSchema.parse({ id: "C001", command: "python x.py --flag" });
    expect(checkFix(check, "python", "python3")).toBe(
      'visp brief --patch - --reason "python is not installed" with {"checks":[{"id":"C001","command":"python3 x.py --flag"}]}',
    );
    const argv = productCheckSchema.parse({ id: "C002", command: ["python", "-m", "pytest"] });
    expect(checkFix(argv, "python", "python3")).toContain('"command":["python3","-m","pytest"]');
  });

  it("never gates a pinned test or a browser journey", async () => {
    await install("python3");
    vi.stubEnv("PATH", bin);
    expect(
      uninstalledAlias(productCheckSchema.parse({ id: "C001", command: "python x.py" })),
    ).toMatchObject({ argv0: "python", alias: "python3" });
    expect(
      uninstalledAlias(productCheckSchema.parse({ id: "PINNED_1", command: "python x.py" })),
    ).toBeUndefined();
    expect(
      uninstalledAlias(
        productCheckSchema.parse({
          id: "C003",
          command: { kind: "browser-journey", journey: { url: "file:///a.html", actions: [] } },
        }),
      ),
    ).toBeUndefined();
  });
});

async function useCheck(command: string) {
  if (!workspace) throw new Error("no workspace");
  const updated = await updateProductBrief(await workspace.state(), {
    brief: { ...brief, checks: brief.checks.map((check) => ({ ...check, command })) },
    reason: "Use a check that needs an interpreter",
  });
  if (!updated.ok) throw new Error(updated.error.message);
}

describe("work gate", () => {
  it("blocks authorization when the check runs python and only python3 is installed", async () => {
    if (!workspace) throw new Error("no workspace");
    await useCheck("python x.py");
    await pathWith("python3");
    const worked = await runProductWork(await workspace.state());
    expect(worked).toMatchObject({
      ok: false,
      error: {
        code: "STAGE_BLOCKED",
        message:
          'Check C001 runs "python", which is not installed here; "python3" is. visp brief --patch - --reason "python is not installed" with {"checks":[{"id":"C001","command":"python3 x.py"}]}',
      },
    });
  });

  it.each([
    ["python and python3", ["python", "python3"]],
    ["neither", []],
  ])("does not gate when %s are installed", async (_name, installed) => {
    if (!workspace) throw new Error("no workspace");
    await useCheck("python x.py");
    await pathWith(...installed);
    expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
  });

  it("lets work through once the check names the installed interpreter", async () => {
    if (!workspace) throw new Error("no workspace");
    await useCheck("python3 x.py");
    await pathWith("python3");
    expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
  });
});

describe("missing executable at run time", () => {
  async function execute(id: string, command: string[]) {
    if (!workspace) throw new Error("no workspace");
    const state = await workspace.state();
    const record = await readProductRecord(state);
    if (!record.ok) throw new Error(record.error.message);
    const check = productCheckSchema.parse({ id, command });
    return executeProductCheck(state, record.value, undefined, check, "subject");
  }

  it("says which alias exists and which patch to apply, in a short message", async () => {
    await pathWith("python3");
    const { execution } = await execute("C001", ["python", "x.py"]);
    expect(execution.status).toBe("environment-failed");
    expect(execution.output).toContain(
      'missing-command: "python" is not installed in this environment ("python3" is).',
    );
    expect(execution.output).toContain(
      "Check C001 was not run, so nothing about the product was tested.",
    );
    expect(execution.output).toContain(
      'Change the check: visp brief --patch - --reason "python is not installed" with {"checks":[{"id":"C001","command":["python3","x.py"]}]}, then run visp done.',
    );
    expect(execution.output.length).toBeLessThan(600);
  });

  it("asks for an installed executable when no alias exists", async () => {
    await pathWith();
    const { execution } = await execute("C001", ["visp-missing-tool", "run"]);
    expect(execution.output).toContain('missing-command: "visp-missing-tool" is not installed');
    expect(execution.output).not.toContain("is).");
    expect(execution.output).toContain("Use an installed executable in the check");
    expect(execution.output).not.toContain("executable argv");
  });

  it("explains argv when the first element is prose", async () => {
    await pathWith();
    const { execution } = await execute("C001", ["open the page"]);
    expect(execution.output).toContain("executable argv");
  });

  it("does not tell the worker to edit a pinned test", async () => {
    await pathWith("python3");
    const { execution } = await execute("PINNED_1", ["python", "x.py"]);
    expect(execution.output).toContain("missing-command:");
    expect(execution.output).toContain("This pinned test is VISP's: do not edit it");
    expect(execution.output).not.toContain("visp brief --patch");
  });

  it("uses the short sentence as the environment recovery", async () => {
    await pathWith("python3");
    const { execution } = await execute("C001", ["python", "x.py"]);
    const next = environmentNext("001-feature", "T001", [`C001: ${execution.output}`], "verify");
    expect(next.objective).toBe(
      execution.output.slice(execution.output.indexOf("missing-command:")),
    );
    expect(next.recovery).toBe(next.objective);
    expect(next.objective.length).toBeLessThan(600);
    expect(next.command).toBe("visp verify --feature 001-feature --task T001");
  });

  it("keeps the generic recovery when no command is missing", () => {
    const next = environmentNext("001-feature", undefined, ["C001: something else"], "verify");
    expect(next.recovery).toContain("Inspect the recorded execution error first");
    expect(next.command).toContain("--retry-environment");
  });
});
