import { basename } from "node:path";
import { detectPreset, readPackageJson } from "../../config/detect.js";
import { renderConfigTemplate, suggestedValidationCommands } from "../../config/template.js";
import {
  HARNESSES,
  type Harness,
  PRODUCT_NAME,
  type Preset,
  STATE_DIR,
} from "../../core/constants.js";
import { planDerivedStateIgnore } from "../../core/derived-ignore.js";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
  recoverFileTransactions,
} from "../../core/file-transaction.js";
import { ProjectFileSystem } from "../../core/fs.js";
import { isRepository, repositoryRequiredError } from "../../core/git.js";
import { ProjectPaths } from "../../core/paths.js";
import { err, ok, type Result } from "../../core/result.js";
import { now } from "../artifacts/common.js";
import { emptyStatus } from "../artifacts/project.js";

export interface InitOptions {
  readonly root: string;
  readonly harness?: Harness;
  readonly force?: boolean;
}

export interface InitRuntime {
  /** Test seam for exercising the workflow's complete mutation plan. */
  readonly applyTransaction?: (
    root: string,
    label: string,
    mutations: readonly FileMutation[],
  ) => ReturnType<typeof applyFileTransaction>;
}

export interface InitOutcome {
  readonly preset: string;
  readonly harness: Harness;
  readonly configPath: string;
  readonly createdConfig: boolean;
  readonly hasGit: boolean;
}

interface InitPlan {
  readonly preset: Preset;
  readonly harness: Harness;
  readonly configExists: boolean;
  readonly mutations: FileMutation[];
}

/**
 * In a usable Git repository, creates `.visp/` and a starter `visp.yml`.
 * Existing files are left alone unless `--force`, so re-running init never
 * discards a project's settings.
 */
export async function runInit(
  options: InitOptions,
  runtime: InitRuntime = {},
): Promise<Result<InitOutcome>> {
  if (options.harness === undefined) {
    return err(
      vispError("UNSUPPORTED", "Choose the AI coding harness to initialize; VISP will not guess", {
        recovery: `${PRODUCT_NAME} init --harness <${HARNESSES.join("|")}>`,
      }),
    );
  }
  const paths = new ProjectPaths(options.root);
  const files = new ProjectFileSystem(paths.root);
  const ready = await ensureInitReady(paths, files, options.force === true, options.harness);
  if (!ready.ok) return ready;
  const plan = await planInit(paths, files, options, options.harness);
  if (!plan.ok) return plan;
  const apply = runtime.applyTransaction ?? applyFileTransaction;
  const applied = await apply(paths.root, "project-init", plan.value.mutations);
  if (!applied.ok) return applied;

  return ok({
    preset: plan.value.preset,
    harness: plan.value.harness,
    configPath: paths.config,
    createdConfig: !plan.value.configExists || Boolean(options.force),
    hasGit: true,
  });
}

async function ensureInitReady(
  paths: ProjectPaths,
  files: ProjectFileSystem,
  force: boolean,
  harness: Harness,
): Promise<Result<void>> {
  // Init must be the first safe boundary. Writing partial Visp state in a
  // workspace where hooks and diffs cannot work invites an agent to treat the
  // later refusal as optional and continue directly against project files.
  if (!(await isRepository(paths.root))) {
    const gitDirectory = await files.exists(".git");
    if (!gitDirectory.ok) return gitDirectory;
    return err(repositoryRequiredError(gitDirectory.value));
  }
  const recovered = await recoverFileTransactions(paths.root);
  if (!recovered.ok) return recovered;
  const stateExists = await hasExistingState(files);
  if (!stateExists.ok) return stateExists;
  return stateExists.value && !force
    ? err(
        vispError("ALREADY_INITIALIZED", `${STATE_DIR}/ already exists`, {
          recovery: `visp init --harness ${harness} --force to rewrite it, or visp status to see the current state`,
        }),
      )
    : ok(undefined);
}

async function hasExistingState(files: ProjectFileSystem): Promise<Result<boolean>> {
  const entries = await files.listEntries(STATE_DIR);
  if (!entries.ok) return entries;
  if (entries.value.length === 0) return ok(false);
  if (
    entries.value.length !== 1 ||
    entries.value[0]?.name !== "state" ||
    entries.value[0]?.type !== "directory"
  ) {
    return ok(true);
  }
  const coordination = await files.listEntries(`${STATE_DIR}/state`);
  return coordination.ok ? ok(coordination.value.length > 0) : coordination;
}

async function planInit(
  paths: ProjectPaths,
  files: ProjectFileSystem,
  options: InitOptions,
  harness: Harness,
): Promise<Result<InitPlan>> {
  const preset = await detectPreset(paths.root);
  const timestamp = now();
  const project = {
    kind: "project",
    createdAt: timestamp,
    name: basename(paths.root),
    preset,
    languages: [],
    hasGit: true,
  } as const;
  const projectMutation = await plannedWrite(files, paths.project, json(project));
  if (!projectMutation.ok) return projectMutation;
  const statusMutation = await plannedWrite(files, paths.status, json(emptyStatus(timestamp)));
  if (!statusMutation.ok) return statusMutation;
  const config = await plannedConfigMutation(files, paths, preset, harness, options.force === true);
  if (!config.ok) return config;
  const ignored = await planDerivedStateIgnore(files, paths.root);
  if (!ignored.ok) return ignored;
  return ok({
    preset,
    harness,
    configExists: config.value.exists,
    mutations: [
      projectMutation.value,
      statusMutation.value,
      ...(ignored.value ? [ignored.value] : []),
      ...(config.value.mutation ? [config.value.mutation] : []),
    ],
  });
}

async function plannedConfigMutation(
  files: ProjectFileSystem,
  paths: ProjectPaths,
  preset: Preset,
  harness: Harness,
  force: boolean,
): Promise<Result<{ exists: boolean; mutation?: FileMutation }>> {
  const configPresent = await files.exists(paths.config);
  if (!configPresent.ok) return configPresent;
  if (configPresent.value && !force) return ok({ exists: true });
  const manifest = await readPackageJson(paths.root, files);
  const template = renderConfigTemplate({
    preset,
    harness,
    validationCommands: suggestedValidationCommands(preset, manifest?.scripts ?? {}),
  });
  const mutation = await plannedWrite(files, paths.config, template);
  return mutation.ok ? ok({ exists: configPresent.value, mutation: mutation.value }) : mutation;
}

async function plannedWrite(
  files: ProjectFileSystem,
  path: string,
  content: string,
): Promise<Result<FileMutation>> {
  const current = await files.readBytesIfExists(path);
  if (!current.ok) return current;
  const metadata = await files.metadata(path);
  if (!metadata.ok) return metadata;
  return ok({
    kind: "write",
    path,
    content,
    expectedBefore: filePrecondition(current.value, metadata.value?.mode),
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
