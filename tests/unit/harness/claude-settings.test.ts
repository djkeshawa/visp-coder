import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_SETTINGS_FILE,
  hookCommand,
  PRE_TOOL_USE_MATCHER,
  planPreToolUseUnregistration,
  preToolUseRegistration,
  registerPreToolUseHook,
} from "../../../src/harness/claude-settings.js";

const HOOK_PATH = ".visp/hooks/claude-pretooluse.mjs";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-claude-settings-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(content: string): Promise<void> {
  const path = join(root, CLAUDE_SETTINGS_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

interface HookEntry {
  matcher?: string;
  hooks?: { command?: string }[];
}

interface Settings {
  hooks?: { PreToolUse?: HookEntry[]; PostToolUse?: HookEntry[] };
  [key: string]: unknown;
}

async function read(): Promise<Settings> {
  return JSON.parse(await readFile(join(root, CLAUDE_SETTINGS_FILE), "utf8"));
}

describe("registerPreToolUseHook", () => {
  it("creates the file when none exists", async () => {
    const result = await registerPreToolUseHook(root, HOOK_PATH, false);
    expect(result.ok && result.value).toBe("added");

    // The edit check, plus the shell check that refuses deleting VISP state.
    const entries = (await read()).hooks?.PreToolUse ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]?.matcher).toBe(PRE_TOOL_USE_MATCHER);
    expect(entries[1]?.matcher).toBe("Bash");
    expect(entries[0]?.hooks?.[0]?.command).toBe(hookCommand(HOOK_PATH));
  });

  it("keeps hooks the project already configured", async () => {
    await write(
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }],
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "./fmt.sh" }] }],
        },
      }),
    );

    await registerPreToolUseHook(root, HOOK_PATH, false);

    const settings = await read();
    const pre = settings.hooks?.PreToolUse ?? [];
    expect(pre).toHaveLength(3);
    expect(pre[0]?.hooks?.[0]?.command).toBe("./audit.sh");
    expect(settings.hooks?.PostToolUse).toBeDefined();
  });

  it("preserves unrelated top-level keys", async () => {
    await write(JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls:*)"] } }));

    await registerPreToolUseHook(root, HOOK_PATH, false);

    const settings = await read();
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("reports an unchanged registration as current", async () => {
    await registerPreToolUseHook(root, HOOK_PATH, false);
    const second = await registerPreToolUseHook(root, HOOK_PATH, false);
    expect(second.ok && second.value).toBe("current");
  });

  /**
   * A narrowed matcher is a deliberate choice. Restoring it on every install
   * would undo the edit without saying so.
   */
  it("leaves a customised matcher alone unless forced", async () => {
    await write(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: hookCommand(HOOK_PATH) }] },
          ],
        },
      }),
    );

    const result = await registerPreToolUseHook(root, HOOK_PATH, false);
    expect(result.ok && result.value).toBe("customized");
    expect((await read()).hooks?.PreToolUse?.[0]?.matcher).toBe("Write");
  });

  it("restores the matcher when forced", async () => {
    await write(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Write", hooks: [{ type: "command", command: hookCommand(HOOK_PATH) }] },
          ],
        },
      }),
    );

    const result = await registerPreToolUseHook(root, HOOK_PATH, true);
    expect(result.ok && result.value).toBe("replaced");
    expect((await read()).hooks?.PreToolUse?.[0]?.matcher).toBe(PRE_TOOL_USE_MATCHER);
  });

  it("refuses to rewrite a malformed file", async () => {
    await write("{ not json");

    const result = await registerPreToolUseHook(root, HOOK_PATH, false);
    expect(result.ok && result.value).toBe("malformed");
    expect(await readFile(join(root, CLAUDE_SETTINGS_FILE), "utf8")).toBe("{ not json");
  });

  it("replaces a malformed file only when forced", async () => {
    await write("{ not json");

    const result = await registerPreToolUseHook(root, HOOK_PATH, true);
    expect(result.ok && result.value).toBe("replaced");
    expect((await read()).hooks?.PreToolUse).toHaveLength(2);
  });

  /** Valid JSON, but not a settings object; rewriting would discard it. */
  it("treats a JSON array as malformed", async () => {
    await write("[1, 2, 3]");

    const result = await registerPreToolUseHook(root, HOOK_PATH, false);
    expect(result.ok && result.value).toBe("malformed");
  });

  it("treats an empty file as no settings", async () => {
    await write("   ");

    const result = await registerPreToolUseHook(root, HOOK_PATH, false);
    expect(result.ok && result.value).toBe("added");
  });
});

describe("preToolUseRegistration", () => {
  it("reports absent when nothing is wired", async () => {
    const result = await preToolUseRegistration(root, HOOK_PATH);
    expect(result.ok && result.value).toBe("absent");
  });

  it("reports absent when another hook is wired but not ours", async () => {
    await write(
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ command: "./other.sh" }] }] },
      }),
    );

    const result = await preToolUseRegistration(root, HOOK_PATH);
    expect(result.ok && result.value).toBe("absent");
  });

  it("reports present once registered", async () => {
    await registerPreToolUseHook(root, HOOK_PATH, false);

    const result = await preToolUseRegistration(root, HOOK_PATH);
    expect(result.ok && result.value).toBe("present");
  });

  it("reports an edited command as customized rather than healthy", async () => {
    await write(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: PRE_TOOL_USE_MATCHER,
              hooks: [{ type: "command", command: `${hookCommand(HOOK_PATH)} || true` }],
            },
          ],
        },
      }),
    );

    const result = await preToolUseRegistration(root, HOOK_PATH);
    expect(result.ok && result.value).toBe("customized");
  });

  it("reports malformed rather than guessing", async () => {
    await write("{ not json");

    const result = await preToolUseRegistration(root, HOOK_PATH);
    expect(result.ok && result.value).toBe("malformed");
  });
});

describe("planPreToolUseUnregistration", () => {
  it("removes only the exact VISP registration", async () => {
    await write(
      JSON.stringify({
        model: "opus",
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] },
            {
              matcher: PRE_TOOL_USE_MATCHER,
              hooks: [{ type: "command", command: hookCommand(HOOK_PATH) }],
            },
          ],
          PostToolUse: [{ matcher: "Edit", hooks: [{ command: "./format.sh" }] }],
        },
      }),
    );

    const planned = planPreToolUseUnregistration(
      await readFile(join(root, CLAUDE_SETTINGS_FILE), "utf8"),
      HOOK_PATH,
    );

    expect(planned.status).toBe("removed");
    const next = JSON.parse(planned.content ?? "null") as Settings;
    expect(next.model).toBe("opus");
    expect(next.hooks?.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] },
    ]);
    expect(next.hooks?.PostToolUse).toEqual([
      { matcher: "Edit", hooks: [{ command: "./format.sh" }] },
    ]);
  });

  it("preserves a customized registration for manual review", () => {
    const current = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: PRE_TOOL_USE_MATCHER,
            hooks: [{ type: "command", command: `${hookCommand(HOOK_PATH)} || true` }],
          },
        ],
      },
    });

    const planned = planPreToolUseUnregistration(current, HOOK_PATH);

    expect(planned).toEqual({ status: "customized" });
  });
});

// Codex reads Claude-format hooks from .codex/hooks.json; a Codex worker gets the same
// prompt recording, stop continuation and state protection.
describe("Codex hooks", () => {
  it("installs a Stop, prompt and shell hook for the Codex harness only", async () => {
    const { planFor } = await import("../../../src/harness/targets.js");
    const codex = planFor("codex").assets.find((asset) => asset.path === ".codex/hooks.json");
    const hooks = JSON.parse(codex?.content ?? "{}").hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"]);
    expect(hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(hooks.Stop[0].hooks[0].command).toContain(".visp/hooks/codex-hooks.mjs");
    expect(planFor("codex").manualSteps.join(" ")).toContain("/hooks");
    expect(planFor("claude-code").assets.some((asset) => asset.path === ".codex/hooks.json")).toBe(
      false,
    );
  });
});
