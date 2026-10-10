import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/config/load.js";
import type { InitOutcome } from "../../../src/workflow/stages/init.js";
import { TestProject } from "../../functional/support/project.js";

let project: TestProject | undefined;

afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

describe("init validation suggestions", () => {
  it("prints skipped commands with their add-back instructions and writes only available commands", async () => {
    project = await TestProject.create({
      "package.json": JSON.stringify({
        scripts: {
          test: "visp-init-missing-test-tool",
          lint: "./node_modules/.bin/local-lint",
        },
      }),
    });
    await project.write("node_modules/.bin/local-lint", "#!/bin/sh\nexit 0\n");
    await chmod(join(project.root, "node_modules/.bin/local-lint"), 0o755);

    const result = project.run("init", "--harness", "generic");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Skipped npm run test: test: executable visp-init-missing-test-tool was not found. Once available, add "npm run test" to workflow.validationCommands in visp.yml.',
    );
    const config = parseConfig(await project.read("visp.yml"), "visp.yml");
    expect(config.ok && config.value.workflow.validationCommands).toEqual(["npm run lint"]);
  });

  it("keeps an unactivated project venv in pytest add-back guidance", async () => {
    project = await TestProject.create({ "app.py": "", "pyproject.toml": "" });
    await project.write(".venv/bin/python", "#!/bin/sh\nexit 1\n");
    await chmod(join(project.root, ".venv/bin/python"), 0o755);
    expect(project.env().PATH?.split(":")).not.toContain(join(project.root, ".venv/bin"));

    const result = project.run("init", "--harness", "generic");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'Skipped ./.venv/bin/python -m pytest: ./.venv/bin/python could not import pytest. Once available, add "./.venv/bin/python -m pytest" to workflow.validationCommands in visp.yml.',
    );
    const config = parseConfig(await project.read("visp.yml"), "visp.yml");
    expect(config.ok && config.value.workflow.validationCommands).toEqual([]);

    // Importable and passing now: adopted on a forced re-run.
    await project.write(
      ".venv/bin/python",
      '#!/bin/sh\ncase "$1 $2" in "-c import pytest"|"-m pytest") exit 0;; esac\nexit 1\n',
    );
    const recovered = project.json<InitOutcome>("init", "--harness", "generic", "--force");
    expect(recovered.result.exitCode).toBe(0);
    expect(recovered.envelope.data?.skippedValidationCommands).toEqual([]);
    const recoveredConfig = parseConfig(await project.read("visp.yml"), "visp.yml");
    expect(recoveredConfig.ok && recoveredConfig.value.workflow.validationCommands).toEqual([
      "./.venv/bin/python -m pytest",
    ]);
  });

  it("reports missing npm lifecycle tools in JSON", async () => {
    project = await TestProject.create({
      "package.json": JSON.stringify({
        scripts: {
          pretest: "visp-init-missing-pretest",
          test: "node --test",
        },
      }),
    });

    const { result, envelope } = project.json<InitOutcome>("init", "--harness", "generic");

    expect(result.exitCode).toBe(0);
    expect(envelope.data?.skippedValidationCommands).toEqual([
      {
        command: "npm run test",
        reason: "pretest: executable visp-init-missing-pretest was not found",
      },
    ]);
    const config = parseConfig(await project.read("visp.yml"), "visp.yml");
    expect(config.ok && config.value.workflow.validationCommands).toEqual([]);
  });

  it("adopts a whole-project check only when it passes here now", async () => {
    project = await TestProject.create({
      "package.json": JSON.stringify({
        scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(3)"' },
      }),
    });

    const { result, envelope } = project.json<InitOutcome>("init", "--harness", "generic");

    expect(result.exitCode).toBe(0);
    expect(envelope.data?.skippedValidationCommands).toEqual([
      {
        command: "npm run lint",
        reason: "it fails here now (exit 3), so it would block every change",
      },
    ]);
    const config = parseConfig(await project.read("visp.yml"), "visp.yml");
    expect(config.ok && config.value.workflow.validationCommands).toEqual(["npm run test"]);
  });

  it("uses the Python majority and its project interpreter even with root JS scripts", async () => {
    project = await TestProject.create({
      "app.py": "",
      "models.py": "",
      "lint.js": "",
      "package.json": JSON.stringify({ scripts: { test: "visp-init-missing-test-tool" } }),
    });
    await project.write(
      ".venv/bin/python",
      '#!/bin/sh\ncase "$1 $2" in "-c import pytest"|"-m pytest") exit 0;; esac\nexit 1\n',
    );
    await chmod(join(project.root, ".venv/bin/python"), 0o755);

    const { result, envelope } = project.json<InitOutcome>("init", "--harness", "generic");

    expect(result.exitCode).toBe(0);
    expect(envelope.data?.preset).toBe("python");
    expect(envelope.data?.skippedValidationCommands).toEqual([]);
    const config = parseConfig(await project.read("visp.yml"), "visp.yml");
    expect(config.ok && config.value.workflow.validationCommands).toEqual([
      "./.venv/bin/python -m pytest",
    ]);
  });
});
