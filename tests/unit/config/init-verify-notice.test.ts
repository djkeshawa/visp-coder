import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runInit } from "../../../src/workflow/stages/init.js";

let root: string | undefined;

async function gitProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visp-init-notice-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("announces which suggested checks will run, and the time limit, before running them", async () => {
  root = await gitProject();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  const notice = vi.fn();
  const result = await runInit({ root, harness: "generic", onVerifyChecks: notice });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(notice).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenCalledWith(["npm run test"], 90_000);
});

it("announces nothing when no check is suggested", async () => {
  root = await gitProject();
  const notice = vi.fn();
  const result = await runInit({ root, harness: "generic", onVerifyChecks: notice });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(notice).not.toHaveBeenCalled();
});
