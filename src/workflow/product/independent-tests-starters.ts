import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vispError } from "../../core/errors.js";
import { err, ok } from "../../core/result.js";
import { prepareCommand } from "../../core/windows-command.js";
import type { WorkspaceState } from "../state.js";
import { type IndependentTester, sleep, type TestsStarter } from "./independent-tests-model.js";
import { readTestsRecord, waitForRecord } from "./independent-tests-record.js";
import { writeIndependentTests } from "./independent-tests-run.js";
import { configuredTester, testerCli } from "./tester-session.js";

/** The tester VISP launches for this project, or undefined when it launches no model. */
export function configuredTestsStarter(
  workspace: WorkspaceState,
  channel: "cli" | "mcp" = "cli",
): TestsStarter | undefined {
  const cli = testerCli(workspace);
  const tester = configuredTester(workspace);
  if (!cli || !tester || !runnable(cli)) return undefined;
  // Codex's sandbox ends every process a shell command started, so a detached tester never
  // finished there; a Codex worker's CLI runs it inside `visp feature` instead. The MCP
  // server outlives each call, so it keeps the background process.
  if (channel === "cli" && workspace.config.harness === "codex") return inlineTests(tester);
  // Bundled builds place the CLI entry beside this chunk; source runs test inline.
  const entry = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  return existsSync(entry) ? backgroundTests(entry) : inlineTests(tester);
}

function runnable(cli: string): boolean {
  const probe = prepareCommand(cli, ["--version"]);
  return (
    spawnSync(probe.file, probe.args, {
      stdio: "ignore",
      timeout: 3000,
      windowsVerbatimArguments: probe.windowsVerbatimArguments,
    }).status === 0
  );
}

export function inlineTests(tester: IndependentTester): TestsStarter {
  return Object.assign(
    (workspace: WorkspaceState, feature: string, _waitMs: number, retryFailed?: boolean) =>
      writeIndependentTests(workspace, feature, tester, retryFailed),
    { inProcess: true as const },
  );
}

/**
 * The tester runs in a detached VISP process so an MCP call or a host that kills long
 * shell commands does not lose it; `work` waits up to its channel's limit for the record.
 */
export function backgroundTests(cli: string): TestsStarter {
  return async (workspace, feature, waitMs, retryFailed) => {
    const logPath = workspace.paths.featureFile(feature, "tester-process.log");
    const output = openSync(logPath, "w");
    const child = spawn(
      process.execPath,
      [
        cli,
        "--project",
        workspace.paths.root,
        "work",
        "--feature",
        feature,
        "--write-tests",
        ...(retryFailed ? ["--retry-tests"] : []),
        "--json",
      ],
      { detached: true, stdio: ["ignore", output, output] },
    );
    closeSync(output);
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    child.unref();
    const deadline = Date.now() + waitMs;
    let record = await readTestsRecord(workspace, feature);
    while (record.ok && !record.value && !exited && Date.now() < deadline) {
      await sleep(250);
      record = await readTestsRecord(workspace, feature);
    }
    if (!record.ok) return record;
    if (record.value)
      return ok(await waitForRecord(workspace, feature, deadline - Date.now(), record.value));
    if (!exited) return ok({ version: 1, status: "running", startedAt: new Date().toISOString() });
    const log = (await readFile(logPath, "utf8").catch(() => "")).slice(-600);
    return err(
      vispError("COMMAND_FAILED", `The independent tester exited before starting: ${log}`),
    );
  };
}
