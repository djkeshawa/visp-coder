import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { availableValidationCommands } from "../../../src/config/validation.js";

let root = "";
let environment: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-validation-"));
  environment = { PATH: join(root, "tools") };
  await executable("tools/npm");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function executable(path: string, body = "exit 0", mode = 0o755): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `#!/bin/sh\n${body}\n`);
  await chmod(absolute, mode);
}

describe("availableValidationCommands", () => {
  it("resolves npm script tools from the project's bin directory and PATH without running scripts", async () => {
    await executable("node_modules/.bin/vitest", "echo ran > marker");
    await executable("tools/tsc");
    await executable("tools/eslint");
    const result = await availableValidationCommands(
      root,
      "typescript",
      {
        test: 'CI=1 "vitest" run && missing-later-command',
        typecheck: "tsc --noEmit",
        lint: "eslint .",
      },
      environment,
    );
    expect(result).toEqual({
      commands: ["npm run test", "npm run typecheck", "npm run lint"],
      skipped: [],
    });
    await expect(readFile(join(root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["test", "pretest", "posttest"])(
    "skips npm test when %s's first tool is missing",
    async (name) => {
      await executable("node_modules/.bin/vitest");
      const result = await availableValidationCommands(
        root,
        "javascript",
        {
          test: "vitest",
          [name]: "missing-runner --flag",
        },
        environment,
      );
      expect(result.commands).toEqual([]);
      expect(result.skipped).toEqual([
        { command: "npm run test", reason: `${name}: executable missing-runner was not found` },
      ]);
    },
  );

  it("accepts resolvable pretest and posttest hooks", async () => {
    await executable("tools/runner");
    expect(
      await availableValidationCommands(
        root,
        "javascript",
        {
          pretest: "runner prepare",
          test: "runner test",
          posttest: "runner cleanup",
        },
        environment,
      ),
    ).toEqual({ commands: ["npm run test"], skipped: [] });
  });

  it("checks explicit relative script paths and executable permissions", async () => {
    await executable("node_modules/.bin/karma");
    await executable("tools/unexecutable", "exit 0", 0o644);
    const result = await availableValidationCommands(
      root,
      "javascript",
      {
        test: "./node_modules/.bin/karma start",
        lint: "unexecutable",
      },
      environment,
    );
    expect(result.commands).toEqual(["npm run test"]);
    expect(result.skipped).toEqual([
      { command: "npm run lint", reason: "lint: executable unexecutable was not found" },
    ]);
  });

  it("skips npm scripts when npm itself is missing", async () => {
    await rm(join(root, "tools/npm"));
    await executable("tools/runner");
    const result = await availableValidationCommands(
      root,
      "javascript",
      { test: "runner" },
      environment,
    );
    expect(result.skipped).toEqual([
      { command: "npm run test", reason: "executable npm was not found" },
    ]);
  });

  it.each(["", "$(runner)", '"unterminated', "(runner)"])(
    "skips unresolved shell-leading script %j",
    async (test) => {
      const result = await availableValidationCommands(root, "javascript", { test }, environment);
      expect(result.commands).toEqual([]);
      expect(result.skipped[0]?.reason).toBe("test: first executable could not be determined");
    },
  );

  it("uses the project's virtual environment to import and run pytest", async () => {
    await executable(".venv/bin/python", 'test "$1" = "-c" && test "$2" = "import pytest"');
    expect(await availableValidationCommands(root, "python", {}, environment)).toEqual({
      commands: ["./.venv/bin/python -m pytest"],
      skipped: [],
    });
  });

  it("skips pytest when the project interpreter cannot import it, even if a PATH interpreter can", async () => {
    await executable(".venv/bin/python", "exit 1");
    await executable("tools/python3");
    const result = await availableValidationCommands(root, "python", {}, environment);
    expect(result.commands).toEqual([]);
    expect(result.skipped).toEqual([
      {
        command: "./.venv/bin/python -m pytest",
        reason: "./.venv/bin/python could not import pytest",
      },
    ]);
  });

  it("probes a PATH Python when no project virtual environment exists", async () => {
    await executable("tools/python3", 'test "$1" = "-c" && test "$2" = "import pytest"');
    expect(await availableValidationCommands(root, "python", {}, environment)).toEqual({
      commands: ["python3 -m pytest"],
      skipped: [],
    });
  });

  it("skips pytest when no interpreter resolves", async () => {
    expect(await availableValidationCommands(root, "python", {}, environment)).toEqual({
      commands: [],
      skipped: [{ command: "pytest", reason: "project Python interpreter was not found" }],
    });
  });

  it("bounds a hanging pytest import probe below five seconds", async () => {
    await executable(".venv/bin/python", "/bin/sleep 10");
    const start = Date.now();
    const result = await availableValidationCommands(root, "python", {}, environment);
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(result.commands).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("probe timed out");
  });

  it.each([
    ["go", "go", "go test ./..."],
    ["rust", "cargo", "cargo test"],
  ] as const)(
    "adopts %s commands only when their binary resolves",
    async (preset, binary, command) => {
      expect(await availableValidationCommands(root, preset, {}, environment)).toEqual({
        commands: [],
        skipped: [{ command, reason: `executable ${binary} was not found` }],
      });
      await executable(`tools/${binary}`);
      expect(await availableValidationCommands(root, preset, {}, environment)).toEqual({
        commands: [command],
        skipped: [],
      });
    },
  );
});
