import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import { parse, stringify } from "yaml";
import { registerTools } from "../../../src/mcp/tools/index.js";
import { runProductNext } from "../../../src/workflow/product/status.js";
import { outstandingFeedback } from "../../../src/workflow/product/findings.js";
import { readTestsRecord } from "../../../src/workflow/product/independent-tests.js";
import { type ProductRecord, readProductRecord } from "../../../src/workflow/product/store.js";
import { type CliResult, runCli } from "../../unit/cli/support/cli.js";
import { TestWorkspace } from "../../unit/support/workspace.js";
import { type NormalizeContext, normalize } from "./normalize.js";

/**
 * A private HOME for the whole run: VISP reads user critic defaults and the Codex sign-in
 * from it, and the developer's own settings must not change what a scenario prints.
 */
const home = mkdtempSync(join(tmpdir(), "visp-golden-home-"));
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");

/** The request every scenario starts from: one module whose public value must become two. */
export const REQUEST = "Make the public value module return two instead of one.";
export const GOAL = "Return two from the public value module";

const FILES = {
  "src/value.mjs": "export const value = 1;\n",
  // A trivial, deterministic check: it prints the value it saw and passes only for two.
  "checks/value.check.mjs":
    'import { value } from "../src/value.mjs";\nif (value === 2) console.log("value is 2");\nelse {\n  console.log(`expected 2, got ${value}`);\n  process.exitCode = 1;\n}\n',
};

export const BRIEF = {
  incomplete: false,
  outcomes: [
    {
      id: "O001",
      kind: "functional",
      statement: "The public value is two",
      priority: "must",
      provenance: "user-stated",
    },
  ],
  checks: [
    {
      id: "C001",
      command: ["node", "checks/value.check.mjs"],
      outcomes: ["O001"],
      files: ["src/value.mjs", "checks/value.check.mjs"],
      environment: "node",
    },
  ],
  slices: [
    {
      id: "T001",
      goal: "Return the promised value",
      outcomes: ["O001"],
      scope: {
        allowed: ["src/value.mjs", "checks/value.check.mjs"],
        expected: ["src/value.mjs"],
        forbidden: [],
      },
      checks: ["C001"],
    },
  ],
};

export interface ProjectOptions {
  /** Merged into `critic` in visp.yml; omitted keeps the critic off. */
  readonly critic?: Record<string, unknown>;
  /** The project's host, written to visp.yml before the foundation is installed. */
  readonly harness?: string;
  /** Extra files committed with the fixture. */
  readonly files?: Record<string, string>;
}

/** One scenario's project: a real repository with VISP installed, driven through its adapters. */
export class GoldenProject {
  private constructor(readonly workspace: TestWorkspace) {}

  /** Built once per test file and copied for each scenario, as the unit fixtures do. */
  static async create(options: ProjectOptions = {}): Promise<GoldenProject> {
    const { workspace } = await TestWorkspace.cached(`golden:${JSON.stringify(options)}`, async () => {
      const built = await TestWorkspace.create(
        { ...FILES, ...options.files },
        { critic: !!options.critic },
      );
      const config = parse(await readFile(join(built.root, "visp.yml"), "utf8"));
      if (options.harness) config.harness = options.harness;
      if (options.critic) config.critic = { ...config.critic, ...options.critic };
      await built.write("visp.yml", stringify(config));
      await built.installFoundation();
      built.commit("install foundation");
      return { workspace: built, value: undefined };
    });
    return new GoldenProject(workspace);
  }

  get root(): string {
    return this.workspace.root;
  }

  destroy(): Promise<void> {
    return this.workspace.destroy();
  }

  async cli(...args: string[]): Promise<CliResult> {
    return runCli(this.root, ...args);
  }

  /** The exact text an MCP host receives for one tool call, and the structured envelope. */
  async mcp(tool: string, args: Record<string, unknown> = {}) {
    const handler = (await this.tools()).get(tool);
    if (!handler) throw new Error(`No MCP tool ${tool}`);
    const result = await handler(args, { signal: new AbortController().signal });
    return { text: mcpText(result), result };
  }

  private handlers?: Map<string, ToolHandler>;
  private async tools(): Promise<Map<string, ToolHandler>> {
    if (this.handlers) return this.handlers;
    const handlers = new Map<string, ToolHandler>();
    const server = {
      server: {},
      registerTool(name: string, _config: unknown, callback: ToolHandler) {
        handlers.set(name, callback);
        return {};
      },
    } as unknown as McpServer;
    registerTools(server, this.root, "standard");
    this.handlers = handlers;
    return handlers;
  }

  /** Starts the fixture feature and writes its brief, as a worker would through the CLI. */
  async startFeature(brief: Record<string, unknown> = BRIEF): Promise<string> {
    const started = await this.cli("feature", GOAL, "--source-brief", REQUEST);
    expect(started.exitCode, started.stderr).toBe(0);
    const feature = await this.activeFeature();
    await this.writeBrief(brief);
    return feature;
  }

  async writeBrief(brief: Record<string, unknown> = BRIEF): Promise<CliResult> {
    await this.workspace.write(".visp/drafts/brief.json", JSON.stringify(brief));
    const updated = await this.cli(
      "brief",
      "--patch",
      ".visp/drafts/brief.json",
      "--reason",
      "Define the first usable behavior",
    );
    expect(updated.exitCode, updated.stdout + updated.stderr).toBe(0);
    return updated;
  }

  async activeFeature(): Promise<string> {
    const state = await this.workspace.state();
    const feature = state.status?.activeFeature;
    if (!feature) throw new Error("No active feature");
    return feature;
  }

  /** The product's value module: two satisfies the request, anything else fails the check. */
  setValue(value: number): Promise<void> {
    return this.workspace.write("src/value.mjs", `export const value = ${value};\n`);
  }

  /**
   * What VISP decided, independent of how it was worded: the next action and the gates the
   * product state holds. A changed decision is agent-facing even when the text is unchanged.
   */
  async decision(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const state = await this.workspace.state();
    const next = await runProductNext(state, {});
    const record = await readProductRecord(state, {});
    const tests = record.ok ? await readTestsRecord(state, record.value.brief.feature) : undefined;
    return {
      ...extra,
      next: next.ok
        ? {
            action: next.value.action,
            command: next.value.command,
            mayEdit: next.value.mayEdit,
            completion: next.value.completion,
            task: next.value.task,
            evidence: next.value.evidence.length,
            critic: next.value.criticAdvice?.status,
          }
        : { error: next.error.code },
      product: record.ok ? productGates(record.value) : { unavailable: record.error.code },
      ...(tests?.ok && tests.value
        ? {
            independentTests: {
              status: tests.value.status,
              disputes: (tests.value.disputes ?? []).map((entry) => `${entry.test}: ${entry.status}`),
            },
          }
        : {}),
    };
  }

  /** The normalization this project needs: its own path, and the shared machine values. */
  context(): NormalizeContext {
    return { paths: [[this.root, "<PROJECT>"]] };
  }
}

function productGates(record: ProductRecord) {
  const { state } = record;
  const findings = outstandingFeedback(record);
  return {
    status: state.status,
    slices: Object.fromEntries(
      Object.entries(state.slices).map(([id, slice]) => [id, slice.status]),
    ),
    executions: state.executions.map(
      (execution) =>
        `${execution.check}${execution.task ? `/${execution.task}` : ""}: ${execution.status}`,
    ),
    reviews: state.reviews.length,
    openFindings: {
      required: findings.filter((finding) => finding.required).length,
      advisory: findings.filter((finding) => !finding.required).length,
    },
  };
}

type ToolHandler = (args: Record<string, unknown>, extra: object) => Promise<CallToolResult>;

function mcpText(result: CallToolResult): string {
  return result.content
    .map((entry) => (entry.type === "text" ? entry.text : `[${entry.type} content]`))
    .join("\n--- next content block\n");
}

/**
 * One CLI call as an agent reads it. Each stream is followed by exactly one added newline
 * before the next marker, so a missing or extra trailing newline still shows.
 */
export function cliTranscript(args: readonly string[], result: CliResult): string {
  return [
    `$ visp ${args.map(shellWord).join(" ")}`,
    "--- stdout",
    result.stdout,
    "--- stderr",
    result.stderr,
    `--- exit ${result.exitCode}`,
  ].join("\n");
}

/** One MCP tool call as the host's model reads it: the text content, then whether it failed. */
export function mcpTranscript(
  tool: string,
  args: Record<string, unknown>,
  reply: { text: string; result: CallToolResult },
): string {
  return [
    `> ${tool} ${JSON.stringify(args)}`,
    "--- text",
    reply.text,
    `--- isError ${reply.result.isError === true}`,
  ].join("\n");
}

function shellWord(word: string): string {
  return /^[\w./:=@,+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

const SNAPSHOTS = new URL("../__snapshots__/", import.meta.url);

/** Compares normalized text with its file snapshot; one file per surface and scenario. */
export async function golden(
  name: string,
  text: string,
  context: NormalizeContext = {},
): Promise<void> {
  // Soft, so one run reports every changed surface of a scenario, not only the first.
  await expect.soft(`${normalize(text, context)}\n`).toMatchFileSnapshot(
    new URL(name, SNAPSHOTS).pathname,
  );
}

/**
 * Records a scenario's steps under one folder: each CLI or MCP call's text, and after it the
 * decision VISP holds (`<step>.decision.json`).
 */
export class Recorder {
  constructor(
    readonly project: GoldenProject,
    readonly folder: string,
  ) {}

  async cli(name: string, args: readonly string[]): Promise<CliResult> {
    const result = await this.project.cli(...args);
    await this.save(`${name}.txt`, cliTranscript(args, result));
    await this.decision(name, { exitCode: result.exitCode });
    return result;
  }

  async mcp(name: string, tool: string, args: Record<string, unknown> = {}) {
    const reply = await this.project.mcp(tool, args);
    await this.save(`${name}.mcp.txt`, mcpTranscript(tool, args, reply));
    const structured = reply.result.structuredContent as
      | { ok?: boolean; nextAction?: unknown }
      | undefined;
    await this.decision(`${name}.mcp`, {
      isError: reply.result.isError === true,
      ok: structured?.ok,
      nextAction: structured?.nextAction,
    });
    return reply;
  }

  async decision(name: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.save(
      `${name}.decision.json`,
      JSON.stringify(await this.project.decision(extra), null, 2),
    );
  }

  save(file: string, text: string): Promise<void> {
    return golden(`${this.folder}/${file}`, text, this.project.context());
  }
}
