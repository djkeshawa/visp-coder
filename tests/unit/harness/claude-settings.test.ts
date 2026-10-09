import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "../../../src/core/result.js";
import {
  CLAUDE_SETTINGS_FILE,
  hookCommand,
  PRE_TOOL_USE_MATCHER,
  planPreToolUseRegistration,
  planPreToolUseUnregistration,
  preToolUseRegistration,
} from "../../../src/harness/claude-settings.js";
import { registerPreToolUseHook } from "../support/writers.js";

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
  it.skipIf(process.platform === "win32")(
    "turns an unstartable edit hook into a blocking exit, and no other hook",
    () => {
      const statusOf = (failClosed: boolean): number | undefined => {
        try {
          execFileSync("/bin/sh", ["-c", hookCommand(HOOK_PATH, failClosed)], {
            cwd: root,
            env: { ...process.env, CLAUDE_PROJECT_DIR: root, PATH: "/nonexistent" },
            stdio: "ignore",
          });
          return 0;
        } catch (error) {
          return (error as { status?: number }).status;
        }
      };
      expect(statusOf(true)).toBe(2);
      // Claude Code treats any other non-zero status as a non-blocking error.
      expect(statusOf(false)).not.toBe(2);
    },
  );
  it("creates the file when none exists", async () => {
    const result = await registerPreToolUseHook(root, HOOK_PATH, false);
    expect(result.ok && result.value).toBe("added");

    // The edit check, plus the shell check that refuses deleting VISP state.
    const entries = (await read()).hooks?.PreToolUse ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]?.matcher).toBe(PRE_TOOL_USE_MATCHER);
    expect(entries[1]?.matcher).toBe("Bash");
    expect(entries[0]?.hooks?.[0]?.command).toBe(hookCommand(HOOK_PATH, true));
    expect(entries[0]?.hooks?.[0]?.command).toContain("|| exit 2");
    // Only the edit matcher fails closed; prompt, Stop and shell entries never block a crash.
    expect(entries[1]?.hooks?.[0]?.command).toBe(hookCommand(HOOK_PATH, false));
    const { hooks } = (await read()) as { hooks: Record<string, HookEntry[]> };
    for (const entry of [entries[1], ...(hooks.UserPromptSubmit ?? []), ...(hooks.Stop ?? [])])
      expect(entry?.hooks?.[0]?.command).not.toContain("exit");
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
            {
              matcher: "Write",
              hooks: [{ type: "command", command: hookCommand(HOOK_PATH, true) }],
            },
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
            {
              matcher: "Write",
              hooks: [{ type: "command", command: hookCommand(HOOK_PATH, true) }],
            },
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

  /** Parseable settings whose hooks Claude Code could not read either. */
  it.each([
    ["hooks is an array", { hooks: [] }],
    ["PreToolUse is not an array", { hooks: { PreToolUse: { matcher: "Edit" } } }],
    ["a PreToolUse entry is not an object", { hooks: { PreToolUse: ["./audit.sh"] } }],
  ])("refuses to rewrite settings when %s", async (_shape, settings) => {
    const content = JSON.stringify(settings);
    await write(content);

    const result = await registerPreToolUseHook(root, HOOK_PATH, false);
    expect(result.ok && result.value).toBe("malformed");
    expect(await readFile(join(root, CLAUDE_SETTINGS_FILE), "utf8")).toBe(content);
  });

  it("replaces malformed hooks when forced and keeps other settings", async () => {
    await write(JSON.stringify({ model: "opus", hooks: { PreToolUse: "./audit.sh" } }));

    const result = await registerPreToolUseHook(root, HOOK_PATH, true);
    expect(result.ok && result.value).toBe("replaced");
    const next = await read();
    expect(next.model).toBe("opus");
    expect(next.hooks?.PreToolUse?.[0]?.matcher).toBe(PRE_TOOL_USE_MATCHER);
  });
});

describe("planPreToolUseRegistration discarding", () => {
  it("recognizes its own entry written with Windows path separators", () => {
    const command = 'node "%CLAUDE_PROJECT_DIR%\\.visp\\hooks\\claude-pretooluse.mjs" || exit /b 2';
    const current = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Write", hooks: [{ type: "command", command }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "node .\\tools\\lint.mjs" }] },
        ],
      },
    });

    expect(planPreToolUseRegistration(current, HOOK_PATH, false)).toEqual(
      ok({ status: "customized" }),
    );
  });

  it("marks a forced rewrite of unparseable or malformed hooks as discarding", () => {
    for (const current of ["{ not json", JSON.stringify({ hooks: { PreToolUse: "x" } })]) {
      const plan = planPreToolUseRegistration(current, HOOK_PATH, true);
      expect(plan.ok && plan.value).toMatchObject({ status: "replaced", discarded: true });
    }
  });

  it("does not mark an ordinary merge as discarding", () => {
    const plan = planPreToolUseRegistration(JSON.stringify({ model: "opus" }), HOOK_PATH, true);
    expect(plan.ok && plan.value.discarded).toBeUndefined();
  });

  it("keeps sibling hook events when PreToolUse is not an array, and none when hooks is not an object", () => {
    const sibling = { matcher: "Bash", hooks: [{ command: "./log.sh" }] };
    const kept = planPreToolUseRegistration(
      JSON.stringify({ hooks: { PreToolUse: "x", PostToolUse: [sibling] } }),
      HOOK_PATH,
      true,
    );
    expect(kept.ok && JSON.parse(kept.value.content ?? "").hooks.PostToolUse).toEqual([sibling]);
    const none = planPreToolUseRegistration(JSON.stringify({ hooks: [sibling] }), HOOK_PATH, true);
    expect(none.ok && Object.keys(JSON.parse(none.value.content ?? "").hooks).sort()).toEqual([
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
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
              hooks: [{ type: "command", command: `${hookCommand(HOOK_PATH, true)} || true` }],
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
              hooks: [{ type: "command", command: hookCommand(HOOK_PATH, true) }],
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
            hooks: [{ type: "command", command: `${hookCommand(HOOK_PATH, true)} || true` }],
          },
        ],
      },
    });

    const planned = planPreToolUseUnregistration(current, HOOK_PATH);

    expect(planned).toEqual({ status: "customized" });
  });

  it("reports absent when there is no settings file", () => {
    expect(planPreToolUseUnregistration(undefined, HOOK_PATH)).toEqual({ status: "absent" });
  });

  it.each([
    ["unparseable", "{ not json"],
    ["hooks is not an object", JSON.stringify({ hooks: "none" })],
    ["PreToolUse is not an array", JSON.stringify({ hooks: { PreToolUse: {} } })],
  ])("leaves %s settings alone", (_shape, current) => {
    expect(planPreToolUseUnregistration(current, HOOK_PATH)).toEqual({ status: "malformed" });
  });
});

// Installs from before the session hooks have only the edit hook; projects keep their own.
describe("session hooks", () => {
  const editOnly = {
    matcher: PRE_TOOL_USE_MATCHER,
    hooks: [{ type: "command", command: hookCommand(HOOK_PATH, true) }],
  };
  const notify = { hooks: [{ type: "command", command: "./notify.sh" }] };
  const staleStop = {
    hooks: [{ type: "command", command: hookCommand(HOOK_PATH, false), timeout: 5 }],
  };

  it("adds the prompt, Stop and shell hooks to an older install without touching the project's", () => {
    const current = JSON.stringify({
      hooks: { PreToolUse: [editOnly], Stop: [notify, staleStop], PostToolUse: [notify] },
    });
    const planned = planPreToolUseRegistration(current, HOOK_PATH, false);
    if (!planned.ok) throw new Error(planned.error.message);
    expect(planned.value.status).toBe("replaced");
    const next = JSON.parse(planned.value.content ?? "null") as {
      hooks: Record<"PreToolUse" | "PostToolUse" | "Stop" | "UserPromptSubmit", HookEntry[]>;
    };
    expect(next.hooks.PostToolUse).toEqual([notify]);
    expect(next.hooks.Stop).toHaveLength(2);
    expect(next.hooks.Stop[0]).toEqual(notify);
    expect(next.hooks.Stop[1]).not.toEqual(staleStop);
    expect(next.hooks.UserPromptSubmit).toHaveLength(1);
    expect(next.hooks.PreToolUse.map((entry) => entry.matcher)).toEqual([
      PRE_TOOL_USE_MATCHER,
      "Bash",
    ]);
    const again = planPreToolUseRegistration(planned.value.content, HOOK_PATH, false);
    expect(again.ok && again.value).toEqual({ status: "current" });
  });

  it("removes only VISP's session hooks", () => {
    const planned = planPreToolUseRegistration(
      JSON.stringify({ hooks: { PreToolUse: [editOnly], Stop: [notify] } }),
      HOOK_PATH,
      false,
    );
    if (!planned.ok) throw new Error(planned.error.message);
    const removed = planPreToolUseUnregistration(planned.value.content, HOOK_PATH);
    expect(removed.status).toBe("removed");
    expect(JSON.parse(removed.content ?? "null")).toEqual({
      hooks: { PreToolUse: [], Stop: [notify] },
    });
  });
});

// Older builds gave every entry `|| exit 2`; uninstall and reinstall find them by reference.
describe("entries an older build generated", () => {
  const old = (extra: Record<string, unknown> = {}) => ({
    hooks: [{ type: "command", command: `${hookCommand(HOOK_PATH, false)} || exit 2`, ...extra }],
  });
  const legacy = {
    PreToolUse: [
      { matcher: PRE_TOOL_USE_MATCHER, ...old() },
      { matcher: "Bash", ...old() },
    ],
    UserPromptSubmit: [old()],
    Stop: [old({ timeout: 180 })],
  };

  it("are removed on uninstall, with the project's own hooks kept", () => {
    const notify = { hooks: [{ type: "command", command: "./notify.sh" }] };
    const removed = planPreToolUseUnregistration(
      JSON.stringify({ hooks: { ...legacy, Stop: [notify, ...legacy.Stop] } }),
      HOOK_PATH,
    );
    expect(removed.status).toBe("removed");
    expect(JSON.parse(removed.content ?? "null")).toEqual({
      hooks: { PreToolUse: [], Stop: [notify] },
    });
  });

  it("are replaced, not duplicated, on install", () => {
    const planned = planPreToolUseRegistration(JSON.stringify({ hooks: legacy }), HOOK_PATH, false);
    if (!planned.ok) throw new Error(planned.error.message);
    expect(planned.value.status).toBe("replaced");
    const next = JSON.parse(planned.value.content ?? "null") as {
      hooks: Record<string, HookEntry[]>;
    };
    expect(next.hooks.PreToolUse).toHaveLength(2);
    expect(next.hooks.PreToolUse?.[1]?.hooks?.[0]?.command).toBe(hookCommand(HOOK_PATH, false));
    expect(next.hooks.UserPromptSubmit).toHaveLength(1);
    expect(next.hooks.Stop).toHaveLength(1);
    expect(next.hooks.Stop?.[0]?.hooks?.[0]?.command).toBe(hookCommand(HOOK_PATH, false));
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
    // The command text is unchanged from earlier builds: Codex trusts hooks by a hash of it.
    expect(hooks.Stop[0].hooks[0].command).toMatch(/\|\| exit 2$/);
    expect(planFor("codex").manualSteps.join(" ")).toContain("/hooks");
    expect(planFor("claude-code").assets.some((asset) => asset.path === ".codex/hooks.json")).toBe(
      false,
    );
  });
});
