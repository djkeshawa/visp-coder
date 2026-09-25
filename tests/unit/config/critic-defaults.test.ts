import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { criticDefaultsCommand } from "../../../src/cli/commands/critic-defaults.js";
import { balancedCritic, CRITIC_HARNESSES } from "../../../src/config/critic.js";
import {
  readCriticDefaults,
  resolveCriticDefault,
  resolveCriticPolicy,
  resolveCriticPolicyDetails,
  saveCriticDefaults,
  saveCriticEnabled,
} from "../../../src/config/critic-defaults.js";
import { configSchema } from "../../../src/config/schema.js";
import { renderConfigTemplate } from "../../../src/config/template.js";
import { HARNESSES } from "../../../src/core/constants.js";
import { criticAgentAssets } from "../../../src/harness/critic-agent.js";
import { planFor } from "../../../src/harness/targets.js";
import { createProductFeature, updateProductBrief } from "../../../src/workflow/product/brief.js";
import { criticStatus } from "../../../src/workflow/product/critic-status.js";
import { TestWorkspace } from "../support/workspace.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "visp-critic-home-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await rm(home, { recursive: true, force: true });
});

it("defaults on independently of the installation harness and resolves an explicit reviewer host", async () => {
  for (const harness of ["generic", "opencode", "unknown"]) {
    expect(await resolveCriticPolicy(harness, undefined, home)).toEqual({
      ok: true,
      value: { enabled: true },
    });
  }
  expect(
    await resolveCriticPolicy("generic", { harness: "codex", model: "chosen" }, home),
  ).toMatchObject({
    ok: true,
    value: { enabled: true, config: { harness: "codex", model: "chosen" } },
  });
  expect(await readdir(home)).toEqual([]);
});

it("preserves global and host settings when toggling and applies enabled precedence", async () => {
  expect((await saveCriticEnabled(false, home)).ok).toBe(true);
  expect((await saveCriticDefaults("codex", { model: "chosen", maxCalls: 1 }, home)).ok).toBe(true);
  expect(await resolveCriticPolicy("codex", undefined, home)).toEqual({
    ok: true,
    value: { enabled: false },
  });
  expect(await resolveCriticPolicy("generic", undefined, home)).toEqual({
    ok: true,
    value: { enabled: false },
  });
  expect((await saveCriticDefaults("codex", { enabled: true }, home)).ok).toBe(true);
  expect(await resolveCriticPolicy("generic", { harness: "codex" }, home)).toMatchObject({
    ok: true,
    value: { enabled: true, config: { model: "chosen", maxCalls: 1 } },
  });
  expect(await resolveCriticPolicy("codex", { enabled: false }, home)).toEqual({
    ok: true,
    value: { enabled: false },
  });
  expect(
    (await saveCriticDefaults("cursor", { enabled: false, model: "cursor-choice" }, home)).ok,
  ).toBe(true);
  expect((await saveCriticEnabled(true, home)).ok).toBe(true);
  expect(await resolveCriticPolicy("cursor", undefined, home)).toEqual({
    ok: true,
    value: { enabled: false },
  });
  expect(await resolveCriticPolicy("cursor", { enabled: true }, home)).toMatchObject({
    ok: true,
    value: { enabled: true, config: { model: "cursor-choice" } },
  });
  expect(await readCriticDefaults(home)).toMatchObject({
    ok: true,
    value: {
      value: {
        version: 1,
        enabled: true,
        hosts: {
          codex: { enabled: true, model: "chosen", maxCalls: 1 },
          cursor: { enabled: false, model: "cursor-choice" },
        },
      },
    },
  });
});

it("serializes concurrent switches without losing host overrides", async () => {
  const saved = await Promise.all([
    saveCriticEnabled(false, home),
    saveCriticDefaults("codex", { model: "chosen", maxCalls: 1 }, home),
    saveCriticDefaults("cursor", { enabled: true }, home),
  ]);
  expect(saved.every((result) => result.ok)).toBe(true);
  expect(await readCriticDefaults(home)).toMatchObject({
    ok: true,
    value: {
      value: {
        enabled: false,
        hosts: { codex: { model: "chosen", maxCalls: 1 }, cursor: { enabled: true } },
      },
    },
  });
});

it("rejects malformed defaults without overwriting their bytes", async () => {
  const path = join(home, ".config/visp/critic-defaults.json");
  await mkdir(join(home, ".config/visp"), { recursive: true });
  for (const content of ["{invalid", '{"version":1,"enabled":"yes","hosts":{}}']) {
    await writeFile(path, content);
    expect((await readCriticDefaults(home)).ok).toBe(false);
    expect((await resolveCriticPolicy("codex", undefined, home)).ok).toBe(false);
    expect((await saveCriticEnabled(true, home)).ok).toBe(false);
    expect((await saveCriticDefaults("codex", { model: "chosen" }, home)).ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe(content);
  }
  expect((await saveCriticDefaults("codex", { harness: "cursor" }, home)).ok).toBe(false);
  expect((await resolveCriticPolicy("codex", { maxCalls: 7 }, home)).ok).toBe(false);
});

it("supports CLI global and host switches without resetting model or limits", async () => {
  vi.stubEnv("HOME", home);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  async function run(...args: string[]) {
    await new Command("visp")
      .option("--json")
      .addCommand(criticDefaultsCommand())
      .parseAsync(["defaults", "--json", ...args], { from: "user" });
  }
  await run();
  expect(await readdir(home)).toEqual([]);
  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).data.enabledByDefault).toBe(true);
  await run("--save", "--off");
  await run("--save", "--harness", "codex", "--model", "chosen", "--max-calls", "1");
  await run("--save", "--harness", "codex", "--on");
  expect(await resolveCriticPolicy("codex", undefined, home)).toMatchObject({
    ok: true,
    value: { enabled: true, config: { model: "chosen", maxCalls: 1 } },
  });
  await run("--save", "--harness", "codex", "--off");
  await run("--save", "--on");
  expect(await readCriticDefaults(home)).toMatchObject({
    ok: true,
    value: {
      value: { enabled: true, hosts: { codex: { enabled: false, model: "chosen", maxCalls: 1 } } },
    },
  });
  await run("--save", "--mode", "both");
  expect(await readCriticDefaults(home)).toMatchObject({
    ok: true,
    value: { value: { mode: "both" } },
  });
  await run("--save", "--harness", "cursor", "--mode", "manual");
  expect(await resolveCriticPolicy("cursor", undefined, home)).toEqual({
    ok: true,
    value: { enabled: false, manual: true },
  });
  const before = await readFile(join(home, ".config/visp/critic-defaults.json"), "utf8");
  await expect(run("--mode", "manual")).rejects.toThrow("Use --save");
  await expect(run("--save", "--mode", "manual", "--on")).rejects.toThrow("Choose mode");
  await expect(run("--save", "--on", "--off")).rejects.toThrow("either --on or --off");
  await expect(run("--on")).rejects.toThrow("Use --save");
  await expect(run("--save", "--model", "chosen")).rejects.toThrow("Use --harness");
  await expect(run("--save")).rejects.toThrow("Use --on or --off");
  expect(await readFile(join(home, ".config/visp/critic-defaults.json"), "utf8")).toBe(before);
  expect(output.mock.calls.at(-1)?.[0]).toContain("existing feature");
});

it("reads without creating state, saves one host transactionally and applies project overrides", async () => {
  expect((await readCriticDefaults(home)).ok).toBe(true);
  expect(await readdir(home)).toEqual([]);
  expect(await resolveCriticDefault("codex", undefined, home)).toMatchObject({
    ok: true,
    value: { model: "gpt-5.6-sol", maxCalls: 3 },
  });
  expect((await saveCriticDefaults("codex", { model: "chosen", maxCalls: 1 }, home)).ok).toBe(true);
  expect((await saveCriticDefaults("cursor", { enabled: false }, home)).ok).toBe(true);
  expect(await resolveCriticDefault("codex", { reasoningEffort: "medium" }, home)).toMatchObject({
    ok: true,
    value: { model: "chosen", maxCalls: 1, reasoningEffort: "medium" },
  });
  expect(await resolveCriticDefault("cursor", undefined, home)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await resolveCriticDefault("cursor", { enabled: true }, home)).toMatchObject({
    ok: true,
    value: { model: "gpt-5.6-sol" },
  });
  expect(await resolveCriticDefault("generic", undefined, home)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await resolveCriticDefault("codex", { enabled: false }, home)).toEqual({
    ok: true,
    value: undefined,
  });
  const before = await readFile(join(home, ".config/visp/critic-defaults.json"), "utf8");
  expect((await saveCriticDefaults("other", {}, home)).ok).toBe(false);
  expect((await saveCriticDefaults("codex", { maxCalls: 7 }, home)).ok).toBe(false);
  expect(await readFile(join(home, ".config/visp/critic-defaults.json"), "utf8")).toBe(before);
});

it("does not follow a user defaults symlink", async () => {
  const other = await mkdtemp(join(tmpdir(), "visp-critic-outside-"));
  try {
    await symlink(other, join(home, ".config"));
    expect((await saveCriticDefaults("codex", { model: "chosen" }, home)).ok).toBe(false);
    expect((await saveCriticEnabled(false, home)).ok).toBe(false);
    expect((await resolveCriticPolicy("generic", undefined, home)).ok).toBe(false);
    expect(await readdir(other)).toEqual([]);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

it.each(HARNESSES)(
  "renders valid %s configuration with an actionable opt-out example",
  (harness) => {
    const template = renderConfigTemplate({ preset: "generic", harness, validationCommands: [] });
    const parsed = configSchema.parse(parse(template));
    expect(parsed.critic?.enabled).toBeUndefined();
    expect(parsed.critic?.harness).toBe(balancedCritic(harness)?.harness);
    const optedOut = template
      .replace(/^# critic:$/m, "critic:")
      .replace(/^# {3}harness: codex$/m, "  harness: codex")
      .replace(/^(?:# {3}| {2}# )enabled: false$/m, "  enabled: false");
    expect(configSchema.parse(parse(optedOut)).critic?.enabled).toBe(false);
  },
);

it.each(CRITIC_HARNESSES)(
  "pins the %s default for a fresh feature, without modifying prior feature policy",
  async (harness) => {
    const workspace = await TestWorkspace.create({}, { critic: true });
    try {
      const settings = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
      settings.harness = harness;
      await workspace.write("visp.yml", stringify(settings));
      await workspace.installFoundation();
      workspace.commit("install selected host");
      const first = await createProductFeature(await workspace.state(), {
        goal: "Build one usable behavior",
      });
      if (!first.ok) throw new Error(first.error.message);
      const updated = await updateProductBrief(await workspace.state(), {
        feature: first.value.brief.feature,
        brief: { ...first.value.brief, goal: "Implement that behavior" },
        reason: "Clarify approach",
      });
      expect(updated.ok).toBe(true);
      expect(
        await criticStatus(await workspace.state(), { feature: first.value.brief.feature }),
      ).toMatchObject({
        ok: true,
        value: { enabled: true, transport: "native", callsUsed: 0, reasoningEffort: "high" },
      });
      const featureDir = join(workspace.root, ".visp/features", first.value.brief.feature);
      expect(await readdir(featureDir)).not.toContain("critic");
      settings.critic = { enabled: false };
      await workspace.write("visp.yml", stringify(settings));
      expect(
        await criticStatus(await workspace.state(), { feature: first.value.brief.feature }),
      ).toMatchObject({ ok: true, value: { enabled: true } });
      workspace.commit("turn off new feature defaults");
      const second = await createProductFeature(await workspace.state(), {
        goal: "Another outcome",
      });
      if (!second.ok) throw new Error(second.error.message);
      expect(
        await criticStatus(await workspace.state(), { feature: second.value.brief.feature }),
      ).toEqual({ ok: true, value: { enabled: false } });
      for (const profile of ["minimal", "standard"] as const) {
        const agent = planFor(harness, profile).assets.find((a) =>
          /agents\/visp-critic\./.test(a.path),
        );
        expect(agent?.content).toContain("model");
        expect(agent?.content).toContain("Stop after one response");
      }
    } finally {
      await workspace.destroy();
    }
  },
);

it("renders exact model overrides without inventing unsupported effort settings", () => {
  const preset = balancedCritic("codex");
  if (!preset) throw new Error("preset");
  for (const host of CRITIC_HARNESSES) {
    const assets = criticAgentAssets(host, {
      ...preset,
      harness: host,
      model: "custom-model",
      reasoningEffort: undefined,
    });
    expect(assets[0]?.content).toContain("custom-model");
    expect(assets[0]?.content).not.toContain("effort=undefined");
    expect(assets[0]?.content).not.toContain("effort: high");
  }
  expect(criticAgentAssets("generic", preset)).toEqual([]);
  expect(criticAgentAssets("claude-code", preset)).toEqual([]);
});

it("resolves independent manual/automatic modes with project and host precedence", async () => {
  const { saveCriticMode } = await import("../../../src/config/critic-defaults.js");
  expect((await saveCriticMode("both", home)).ok).toBe(true);
  expect(await resolveCriticPolicy("generic", undefined, home)).toMatchObject({
    ok: true,
    value: { enabled: true, manual: true },
  });
  expect(await resolveCriticPolicy("generic", { mode: "manual" }, home)).toEqual({
    ok: true,
    value: { enabled: false, manual: true },
  });
  expect((await saveCriticDefaults("codex", { mode: "manual" }, home)).ok).toBe(true);
  expect(await resolveCriticPolicy("codex", undefined, home)).toEqual({
    ok: true,
    value: { enabled: false, manual: true },
  });
  expect(await resolveCriticPolicy("codex", { mode: "auto" }, home)).toMatchObject({
    ok: true,
    value: { enabled: true, config: { harness: "codex" } },
  });
  expect((await saveCriticDefaults("codex", { enabled: true }, home)).ok).toBe(true);
  expect(await resolveCriticPolicy("codex", undefined, home)).toMatchObject({
    ok: true,
    value: { enabled: true },
  });
  expect(await resolveCriticPolicy("codex", { mode: "off" }, home)).toEqual({
    ok: true,
    value: { enabled: false },
  });
  expect((await saveCriticMode("invented", home)).ok).toBe(false);
});

it("explains removed personal settings without rewriting the file or accepting new ones", async () => {
  const directory = join(home, ".config/visp");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "critic-defaults.json");
  const text = JSON.stringify({ version: 1, hosts: { codex: { maxInputCharacters: 4000 } } });
  await writeFile(path, text);
  const result = await readCriticDefaults(home);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("hosts.codex.maxInputCharacters");
  expect(result.error.message).toContain("Remove this setting");
  expect(await readFile(path, "utf8")).toBe(text);
  const attempted = await saveCriticDefaults("codex", { maxOutputTokens: 1000 }, home);
  expect(attempted.ok).toBe(false);
  if (attempted.ok) return;
  expect(attempted.error.message).toContain("maxOutputTokens");
  expect(await readFile(path, "utf8")).toBe(text);
});

it("explains field precedence from the same resolution used to pin new features", async () => {
  await saveCriticEnabled(false, home);
  await saveCriticDefaults("codex", { enabled: true, model: "personal-model", maxCalls: 3 }, home);
  const project = { model: "project-model", reasoningEffort: "low" as const };
  const details = await resolveCriticPolicyDetails("codex", project, home);
  expect(details.ok).toBe(true);
  if (!details.ok) throw new Error(details.error.message);
  expect(await resolveCriticPolicy("codex", project, home)).toEqual({
    ok: true,
    value: details.value.policy,
  });
  expect(details.value.sources.mode).toMatchObject({
    source: "personal-host",
    key: "enabled",
    value: "auto",
  });
  expect(details.value.sources.config).toMatchObject({
    model: "project",
    reasoningEffort: "project",
    maxCalls: "personal-host",
    timeoutMs: "built-in",
    harness: "workspace-harness",
  });
  const disabled = await resolveCriticPolicyDetails("codex", { mode: "off" }, home);
  expect(disabled).toMatchObject({
    ok: true,
    value: {
      policy: { enabled: false },
      sources: { mode: { source: "project", key: "mode", value: "off" }, config: {} },
    },
  });
});

it("reports built-in and global mode origins without inventing config for unsupported hosts", async () => {
  expect(await resolveCriticPolicyDetails("generic", undefined, home)).toMatchObject({
    ok: true,
    value: {
      policy: { enabled: true },
      sources: { mode: { source: "built-in", value: "auto" }, config: {} },
    },
  });
  await saveCriticEnabled(false, home);
  expect(await resolveCriticPolicyDetails("codex", undefined, home)).toMatchObject({
    ok: true,
    value: {
      policy: { enabled: false },
      sources: { mode: { source: "personal-global", key: "enabled", value: "off" }, config: {} },
    },
  });
  const selected = await resolveCriticPolicyDetails(
    "generic",
    { enabled: true, harness: "codex" },
    home,
  );
  expect(selected).toMatchObject({
    ok: true,
    value: {
      policy: { enabled: true, config: { harness: "codex" } },
      sources: {
        mode: { source: "project", key: "enabled" },
        config: { harness: "project", model: "built-in" },
      },
    },
  });
});
