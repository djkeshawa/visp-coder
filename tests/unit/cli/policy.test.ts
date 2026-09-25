import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../../../src/core/constants.js";
import { RULES } from "../../../src/workflow/policy/rules.js";
import type { Override } from "../../../src/workflow/policy/schema.js";
import { saveOverrides } from "../../../src/workflow/state.js";
import { TestWorkspace } from "../support/workspace.js";
import { runCli, runJson } from "./support/cli.js";

/**
 * `policy` is where a project decides what visp will refuse. The properties
 * worth holding are about honesty and reach: the report says why each rule is
 * on or off, and the rules protecting the trust boundary cannot be switched off
 * through this command or waived by an override.
 */

interface RuleView {
  id: string;
  title: string;
  active: boolean;
  why: string;
  overridable: boolean;
}

interface ShowData {
  strictness: string;
  rules: RuleView[];
}

/** Not overridable, and on in every strictness mode. */
const PROTECTED_RULE = "scope.forbidden-paths";
/** On from standard up, and waivable by a recorded override. */
const WAIVABLE_RULE = "scope.max-changed-files";
/** Off in standard, on from strict up. */
const STRICT_ONLY_RULE = "evidence.test-signal";

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create();
});

afterEach(async () => {
  await workspace.destroy();
});

async function show(): Promise<ShowData> {
  const { envelope } = await runJson<ShowData>(workspace.root, "policy", "show");
  if (!envelope.data) throw new Error(`policy show failed: ${envelope.error?.message}`);
  return envelope.data;
}

function ruleIn(data: ShowData, id: string): RuleView {
  const found = data.rules.find((rule) => rule.id === id);
  if (!found) throw new Error(`no rule named ${id}`);
  return found;
}

function override(rule: string): Override {
  return {
    id: "O001",
    rule: rule as Override["rule"],
    reason: "Large mechanical rename, agreed with the reviewer beforehand",
    scope: {},
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

describe("policy show", () => {
  it("lists every rule in the catalogue, not just the active ones", async () => {
    const data = await show();

    expect(data.rules).toHaveLength(RULES.length);
    expect(data.strictness).toBe("standard");
  });

  /** An "off" with no explanation is indistinguishable from a rule that failed. */
  it("says why a rule is off rather than only that it is", async () => {
    const data = await show();
    const rule = ruleIn(data, STRICT_ONLY_RULE);

    expect(rule.active).toBe(false);
    expect(rule.why).toBe("off in standard mode");
    expect(ruleIn(data, PROTECTED_RULE).why).toBe("on");
  });

  it("marks the rules that cannot be overridden", async () => {
    const data = await show();
    expect(ruleIn(data, PROTECTED_RULE).overridable).toBe(false);
    expect(ruleIn(data, WAIVABLE_RULE).overridable).toBe(true);

    const { stdout } = await runCli(workspace.root, "policy", "show");
    expect(stdout).toContain("Strictness: standard");
    expect(stdout).toContain("(cannot be overridden)");
    expect(stdout).toContain(PROTECTED_RULE);
  });

  it("names the override that waived a rule, so the hole has an author", async () => {
    const state = await workspace.state();
    const saved = await saveOverrides(state.paths, [override(WAIVABLE_RULE)]);
    if (!saved.ok) throw new Error(saved.error.message);

    const rule = ruleIn(await show(), WAIVABLE_RULE);

    expect(rule.active).toBe(false);
    expect(rule.why).toContain("overridden:");
    expect(rule.why).toContain("agreed with the reviewer");
  });

  /**
   * The refusal the escape hatch must not reach: an override that could disable
   * the rules guarding the trust boundary would defeat having them.
   */
  it("keeps a non-overridable rule on despite a recorded override", async () => {
    const state = await workspace.state();
    const saved = await saveOverrides(state.paths, [override(PROTECTED_RULE)]);
    if (!saved.ok) throw new Error(saved.error.message);

    expect(ruleIn(await show(), PROTECTED_RULE).active).toBe(true);
  });
});

describe("policy set-strictness", () => {
  it("rejects a mode it does not have and lists the ones it does", async () => {
    const { envelope, exitCode } = await runJson(
      workspace.root,
      "policy",
      "set-strictness",
      "paranoid",
    );

    expect(exitCode).toBe(EXIT.usage);
    expect(envelope.error?.code).toBe("UNSUPPORTED");
    expect(envelope.error?.recovery).toContain("standard");
  });

  it("does not change the policy when the mode is rejected", async () => {
    await runJson(workspace.root, "policy", "set-strictness", "paranoid");

    expect((await show()).strictness).toBe("standard");
  });

  it("turns on the rules the new mode enables", async () => {
    expect(ruleIn(await show(), STRICT_ONLY_RULE).active).toBe(false);

    const { envelope, exitCode } = await runJson<{ strictness: string }>(
      workspace.root,
      "policy",
      "set-strictness",
      "strict",
    );

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.data?.strictness).toBe("strict");
    expect(envelope.nextCommand).toContain("policy show");

    const after = await show();
    expect(after.strictness).toBe("strict");
    expect(ruleIn(after, STRICT_ONLY_RULE).active).toBe(true);
  });

  it("reports the change in words as well as json", async () => {
    const { stdout, exitCode } = await runCli(
      workspace.root,
      "policy",
      "set-strictness",
      "relaxed",
    );

    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain("Strictness is now relaxed.");
  });
});

describe("policy set", () => {
  it("rejects a rule id that is not in the catalogue", async () => {
    const { envelope, exitCode } = await runJson(workspace.root, "policy", "set", "be-nice", "on");

    expect(exitCode).toBe(EXIT.usage);
    expect(envelope.error?.code).toBe("UNSUPPORTED");
    expect(envelope.error?.message).toContain("be-nice");
    expect(envelope.error?.recovery).toContain("policy show");
  });

  /** The rules that hold the trust boundary are not a preference. */
  it("refuses to turn off a rule that is not overridable, and says why it exists", async () => {
    const { envelope, exitCode } = await runJson(
      workspace.root,
      "policy",
      "set",
      PROTECTED_RULE,
      "off",
    );

    expect(exitCode).toBe(EXIT.usage);
    expect(envelope.error?.message).toContain("cannot be turned off");
    expect(envelope.error?.message).toContain("Secrets");
    expect(ruleIn(await show(), PROTECTED_RULE).active).toBe(true);
  });

  it("still allows a non-overridable rule to be set on", async () => {
    const { exitCode } = await runJson(workspace.root, "policy", "set", PROTECTED_RULE, "on");

    expect(exitCode).toBe(EXIT.ok);
    expect(ruleIn(await show(), PROTECTED_RULE).active).toBe(true);
  });

  it("turns an overridable rule off and remembers the decision", async () => {
    const { envelope, exitCode } = await runJson<{ rules: Record<string, boolean> }>(
      workspace.root,
      "policy",
      "set",
      WAIVABLE_RULE,
      "off",
    );

    expect(exitCode).toBe(EXIT.ok);
    expect(envelope.data?.rules[WAIVABLE_RULE]).toBe(false);

    const after = await show();
    expect(ruleIn(after, WAIVABLE_RULE).active).toBe(false);
    expect((await workspace.state()).policy.rules[WAIVABLE_RULE]).toBe(false);
  });

  /** An explicit choice outranks the strictness default, in both directions. */
  it("turns on a rule the current mode leaves off", async () => {
    const { exitCode, stdout } = await runCli(
      workspace.root,
      "policy",
      "set",
      STRICT_ONLY_RULE,
      "on",
    );

    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain(`${STRICT_ONLY_RULE} is now on.`);

    const after = await show();
    expect(after.strictness).toBe("standard");
    expect(ruleIn(after, STRICT_ONLY_RULE).active).toBe(true);
  });
});

describe("a project without visp", () => {
  it("refuses every subcommand with the command that would set one up", async () => {
    const bare = await mkdtemp(join(tmpdir(), "visp-cli-policy-"));
    try {
      for (const args of [
        ["policy", "show"],
        ["policy", "set-strictness", "strict"],
        ["policy", "set", WAIVABLE_RULE, "off"],
      ]) {
        const { envelope, exitCode } = await runJson(bare, ...args);

        expect(exitCode, args.join(" ")).toBe(EXIT.missingState);
        expect(envelope.error?.code, args.join(" ")).toBe("NOT_INITIALIZED");
      }
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
