import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderPreToolUseHook } from "../../../src/harness/hooks.js";
import { TESTER_BROWSER_KIT } from "../../../src/workflow/product/tester/tester-browser-kit.js";

const directory = mkdtempSync(join(tmpdir(), "visp-script-source-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function syntaxErrors(name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  try {
    execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
    return "";
  } catch (cause) {
    return String((cause as { stderr?: Buffer }).stderr);
  }
}

describe("script sources", () => {
  it("fills every placeholder of the PreToolUse hook and leaves valid JavaScript", () => {
    const hook = renderPreToolUseHook("/opt/visp/cli.js");
    expect(hook).not.toMatch(/__HOOK_[A-Z_]+__/);
    expect(hook).toContain('const cli = "/opt/visp/cli.js";');
    expect(syntaxErrors("hook.mjs", hook)).toBe("");
  });

  it("keeps a path that looks like a replacement pattern intact", () => {
    expect(renderPreToolUseHook("/tmp/$&/$1/cli.js")).toContain('const cli = "/tmp/$&/$1/cli.js";');
  });

  it("leaves the browser kit as valid JavaScript", () => {
    expect(syntaxErrors("kit.mjs", TESTER_BROWSER_KIT)).toBe("");
  });
});
