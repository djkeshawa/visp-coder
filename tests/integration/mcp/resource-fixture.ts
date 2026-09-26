import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ok } from "../../../src/core/result.js";
import { defaultHooks, installHarness } from "../../../src/harness/install.js";
import { createServer } from "../../../src/mcp/server.js";
import type { ContextPack } from "../../../src/workflow/artifacts/context.js";
import type { Plan, Spec } from "../../../src/workflow/artifacts/feature.js";
import type { TaskGraph } from "../../../src/workflow/artifacts/tasks.js";
import { runInit } from "../../../src/workflow/stages/init.js";
import { loadWorkspace, type WorkspaceState } from "../../../src/workflow/state.js";
import { seedPlan, seedSpec, seedTaskGraph } from "../../unit/support/legacy-artifacts.js";
import { buildContextPack } from "../../unit/support/legacy-context.js";
import { createLegacyFeature as runFeature } from "../../unit/support/legacy-feature.js";
import { legacyStore } from "../../unit/support/legacy-store.js";
import { productWorkspace } from "../../unit/support/product-workspace.js";

/**
 * Shared setup for the resource tests: a throwaway project served over an
 * in-memory transport, so a read goes through the real MCP request path rather
 * than calling the payload functions directly.
 */

/** One content block of a resource read, with its JSON body already parsed. */
export interface ResourceRead {
  readonly uri: string;
  readonly mimeType: string | undefined;
  readonly value: unknown;
}

export interface ResourceProject {
  readonly root: string;
  readonly client: Client;
  /** Reads a resource and parses its single content block. */
  read(uri: string): Promise<ResourceRead>;
  /** The parsed body only, for the common case. */
  readJson(uri: string): Promise<Record<string, unknown>>;
  state(): Promise<WorkspaceState>;
  close(): Promise<void>;
}

export async function startResourceProject(prefix: string): Promise<ResourceProject> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await connect(root);
  } catch (error) {
    // Setup failed, so no test will ever call close() to clean this up.
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function connect(root: string): Promise<ResourceProject> {
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  const init = await runInit({ root, harness: "generic" });
  if (!init.ok) throw new Error(`init failed: ${init.error.message}`);
  const initialized = await workspace(root);
  const installed = await installHarness(
    initialized.paths,
    {
      harness: initialized.config.harness,
      profile: initialized.config.profile,
      hooks: defaultHooks(initialized.config.harness),
      mcp: false,
    },
    { guardHandshake: async () => ok(undefined) },
  );
  if (!installed.ok) throw new Error(`install failed: ${installed.error.message}`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "project baseline");

  return connectResourceProject(root);
}

export async function startProductProject() {
  const product = await productWorkspace();
  try {
    return {
      ...(await connectResourceProject(product.workspace.root)),
      workspace: product.workspace,
      brief: product.brief,
    };
  } catch (error) {
    await product.workspace.destroy();
    throw error;
  }
}

async function connectResourceProject(root: string): Promise<ResourceProject> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "visp-resource-test-client", version: "0.0.0" });
  await Promise.all([createServer(root).connect(serverTransport), client.connect(clientTransport)]);

  const read = async (uri: string): Promise<ResourceRead> => {
    const { contents } = await client.readResource({ uri });
    const entry = contents[0];
    if (!entry) throw new Error(`${uri} returned no content block`);
    // Every visp:// resource is JSON text; a blob block would be a contract break.
    if (!("text" in entry)) throw new Error(`${uri} returned a binary content block`);

    return { uri: entry.uri, mimeType: entry.mimeType, value: JSON.parse(entry.text) };
  };

  return {
    root,
    client,
    read,
    readJson: async (uri) => (await read(uri)).value as Record<string, unknown>,
    state: () => workspace(root),
    close: async () => {
      await client.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export async function workspace(root: string): Promise<WorkspaceState> {
  const state = await loadWorkspace(root);
  if (!state.ok) throw new Error(`workspace unavailable: ${state.error.message}`);
  return state.value;
}

/** A feature with every artifact filled in, as the drafting stages would leave it. */
export interface SeededFeature {
  readonly id: string;
  readonly spec: Spec;
  readonly plan: Plan;
  readonly tasks: TaskGraph;
  readonly pack: ContextPack;
}

/**
 * Builds a feature the way a finished drafting run would: validated spec and
 * plan, a two-task graph with one task already done, and a compiled context
 * pack for the task that is ready. The resource tests compare what they read
 * back against exactly these objects.
 */
export async function seedFeature(root: string, goal = "add login"): Promise<SeededFeature> {
  await writeFileUnder(root, "src/login.ts", "export function login(): void {}\n");
  commitPendingBaseline(root);

  const started = await runFeature(await workspace(root), { goal });
  if (!started.ok) throw new Error(`feature failed: ${started.error.message}`);
  const id = started.value.intent.id;

  const state = await workspace(root);
  const spec = exampleSpec(id, goal);
  const plan = examplePlan(id);
  const tasks = exampleTasks(id);

  await expectOk(legacyStore(state).writeSpec(spec), "spec");
  await expectOk(legacyStore(state).writePlan(plan), "plan");
  await expectOk(legacyStore(state).writeTasks(tasks), "tasks");

  // Compiling the pack is also what makes T002 the active task on disk.
  const built = await buildContextPack(await workspace(root), {
    feature: id,
    taskId: "T002",
    repositoryFiles: ["src/login.ts"],
  });
  if (!built.ok) throw new Error(`context failed: ${built.error.message}`);

  return { id, spec, plan, tasks, pack: built.value.pack };
}

/**
 * A feature left exactly as the drafting stages seed it: placeholder text and
 * every artifact still marked draft.
 */
export async function seedDraftFeature(root: string, goal = "add search"): Promise<string> {
  commitPendingBaseline(root);
  const started = await runFeature(await workspace(root), { goal });
  if (!started.ok) throw new Error(`feature failed: ${started.error.message}`);
  const id = started.value.intent.id;

  const state = await workspace(root);
  await expectOk(
    legacyStore(state).writeIntent({ ...started.value.intent, researchRequired: false }),
    "legacy intent",
  );

  const spec = seedSpec(id);
  const plan = seedPlan(id);
  await expectOk(legacyStore(state).writeSpec(spec), "draft spec");
  await expectOk(legacyStore(state).writePlan(plan), "draft plan");
  await expectOk(legacyStore(state).writeTasks(seedTaskGraph(id, spec, plan)), "draft tasks");
  return id;
}

function commitPendingBaseline(root: string): void {
  if (git(root, "status", "--porcelain=v1").trim() === "") return;
  git(root, "add", "-A");
  git(root, "commit", "-q", "--no-verify", "-m", "fixture baseline");
}

/** Records a verification and a review against a feature, as the gates would. */
export async function recordEvidence(
  root: string,
  feature: string,
  outcome: { verification: boolean; review: boolean },
): Promise<void> {
  const state = await workspace(root);

  await expectOk(
    legacyStore(state).writeVerification({
      kind: "verification",
      createdAt: "2026-01-01T00:00:00.000Z",
      feature,
      task: "T002",
      passed: outcome.verification,
      codeEvidence: "executed",
      commands: [],
      changedFiles: [],
      findings: [],
    }),
    "verification",
  );

  await expectOk(
    legacyStore(state).writeReview({
      kind: "review",
      createdAt: "2026-01-01T00:00:00.000Z",
      feature,
      task: "T002",
      passed: outcome.review,
      basis: "working-tree",
      reviewedFiles: [],
      criteria: [],
      expectedFilesSeen: [],
      expectedFilesMissing: [],
      findings: [],
    }),
    "review",
  );
}

function exampleSpec(feature: string, goal: string): Spec {
  return {
    kind: "spec",
    createdAt: "2026-01-01T00:00:00.000Z",
    feature,
    summary: `Lets a returning user sign in, so that ${goal} is covered end to end`,
    researchFindings: [],
    requirements: [
      {
        id: "REQ001",
        statement: "A user with valid credentials receives a session token",
        priority: "must",
        criteria: [{ id: "AC001", statement: "Signing in with a known password returns a token" }],
      },
    ],
    qualityRequirements: [],
    behaviorScenarios: [],
    outOfScope: ["Password reset"],
    openQuestions: [],
    draft: false,
  };
}

function examplePlan(feature: string): Plan {
  return {
    kind: "plan",
    createdAt: "2026-01-01T00:00:00.000Z",
    feature,
    approach: "Add a token module, then call it from the login entry point",
    researchFindings: [],
    decisions: [{ statement: "Sign tokens locally", rationale: "No identity provider yet" }],
    modules: [],
    invariants: [],
    testStrategy: [],
    risks: ["Token lifetime is not configurable yet"],
    newDependencies: [],
    draft: false,
  };
}

function exampleTasks(feature: string): TaskGraph {
  return {
    kind: "tasks",
    createdAt: "2026-01-01T00:00:00.000Z",
    feature,
    draft: false,
    tasks: [
      {
        id: "T001",
        title: "Add the token module",
        description: "",
        taskClass: "feature",
        riskLevel: "low",
        status: "done",
        requirements: ["REQ001"],
        qualityRequirements: [],
        scenarios: [],
        modules: [],
        dependsOn: [],
        allowedFiles: ["src/token.ts"],
        expectedFiles: ["src/token.ts"],
        forbiddenFiles: [],
        validationCommands: ["pnpm test"],
        validationFiles: [],
        probeRoles: [],
        doneCriteria: ["A token can be signed"],
      },
      {
        id: "T002",
        title: "Call the token module from login",
        description: "",
        taskClass: "feature",
        riskLevel: "low",
        status: "pending",
        requirements: ["REQ001"],
        qualityRequirements: [],
        scenarios: [],
        modules: [],
        dependsOn: ["T001"],
        allowedFiles: ["src/login.ts"],
        expectedFiles: ["src/login.ts"],
        forbiddenFiles: [],
        validationCommands: ["pnpm test"],
        validationFiles: [],
        probeRoles: [],
        doneCriteria: ["Signing in returns a token"],
      },
    ],
  };
}

async function expectOk(
  result: Promise<{ ok: boolean; error?: { message: string } }>,
  label: string,
): Promise<void> {
  const settled = await result;
  if (!settled.ok) throw new Error(`${label} write failed: ${settled.error?.message ?? "unknown"}`);
}

async function writeFileUnder(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}
