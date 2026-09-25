import { Command, Option } from "commander";
import { fromUnknown, vispError } from "../../core/errors.js";
import { parseRiskLevel, parseWorkflowMode } from "../../core/input.js";
import { err, type Result } from "../../core/result.js";
import { BRIEF_INPUT_HELP } from "../../harness/command-guide.js";
import { productCheckTemplate } from "../../workflow/product/check-guidance.js";
import {
  configuredReviewStarter,
  reviewWaitMs,
  runProductAcceptReviewed,
  runProductDoneReviewed,
  runProductNextAfterReview,
} from "../../workflow/product/done-review.js";
import {
  codexTester,
  configuredTestsStarter,
  createProductFeatureWithTests,
  testsWaitMs,
  writeIndependentTests,
} from "../../workflow/product/independent-tests.js";
import {
  readProductBrief,
  runProductContext,
  runProductMigrate,
  runProductReport,
  runProductReproduction,
  runProductStatus,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../workflow/product/index.js";
import {
  parseReviewSubmission,
  runProductReviewRequest,
  validateProductReviewRequest,
} from "../../workflow/product/review-request.js";
import { compactProductReply } from "../../workflow/product-compact-text.js";
import { PRODUCT_BRIEF_ENTRY_GUIDE, productInputTemplate } from "../../workflow/product-inputs.js";
import {
  productNextCommand,
  productResultFailed,
  productWithoutImageBytes,
  renderProductResult,
} from "../../workflow/product-presentation.js";
import type { WorkspaceState } from "../../workflow/state.js";
import {
  type GlobalOptions,
  isJson,
  mutatingWorkspace,
  options,
  validateArtifactSelection,
  workspace,
} from "../context.js";
import { readCommandInput, readStandardInput } from "../input.js";
import { emit, emitError } from "../output.js";

interface ProductOptions extends GlobalOptions {
  finding?: string;
  execution?: string;
  feature?: string;
  task?: string;
  retryEnvironment?: boolean;
  from?: string;
  patch?: string;
  inspect?: boolean;
  reason?: string;
  intentChange?: string;
  provenance?: string;
  dryRun?: boolean;
  template?: boolean;
  checkTemplate?: string;
  detail?: boolean;
  handoff?: boolean;
  dispatch?: boolean;
  prepare?: boolean;
  writeTests?: boolean;
  check?: string;
  session?: string;
  group?: string[];
}

type Operation = (state: WorkspaceState, opts: ProductOptions) => Promise<Result<unknown>>;

/** Adapters only: decisions and data shapes live in the shared product engine. */
function command(
  name: string,
  description: string,
  mutate: boolean,
  run: Operation,
  selectsSlice = true,
): Command {
  const operation = new Command(name)
    .description(description)
    .option("--feature <id>", "Select a feature");
  if (selectsSlice) operation.option("--task <id>", "Select a slice");
  if (["work", "verify", "done", "accept"].includes(name))
    operation.option(
      "--retry-environment",
      "Retry the capability check after host environment recovery",
    );
  return operation.action(async (_flags: unknown, cmd: Command) => {
    const opts = options<ProductOptions>(cmd);
    await execute(name, opts, mutate && !opts.dryRun, run);
  });
}

/** Models read CLI text through a shell; --json keeps the complete result for tools. */
function cliText(name: string, opts: ProductOptions, value: unknown): string {
  // Brief reads and review output are documents the actor edits and submits back.
  const document =
    name === "review" || (name === "brief" && opts.from === undefined && opts.patch === undefined);
  return (
    (document ? undefined : compactProductReply(name, value, "cli")) ?? renderProductResult(value)
  );
}

async function execute(name: string, opts: ProductOptions, mutate: boolean, run: Operation) {
  try {
    const mode = productCommandMode(name, opts);
    if (!mode.ok) {
      process.exitCode = emitError(name, mode.error, { json: isJson(opts) });
      return;
    }
    if (
      (opts.from !== undefined && !opts.from.trim()) ||
      (opts.patch !== undefined && !opts.patch.trim())
    )
      throw new Error("--from must name a project file or - for standard input");
    const checked = validateArtifactSelection(opts);
    if (!checked.ok) {
      process.exitCode = emitError(name, checked.error, { json: isJson(opts) });
      return;
    }
    const loaded = await ((mutate && !opts.inspect) ||
    opts.from !== undefined ||
    opts.patch !== undefined ||
    opts.dispatch ||
    opts.prepare
      ? mutatingWorkspace(opts)
      : workspace(opts));
    if (!loaded.ok) {
      process.exitCode = emitError(name, loaded.error, { json: isJson(opts) });
      return;
    }
    const result = await run(loaded.value, opts);
    process.exitCode = emit(
      name,
      result.ok ? { ok: true, value: productWithoutImageBytes(result.value) } : result,
      {
        json: isJson(opts),
        text: (value) => cliText(name, opts, value),
        nextCommand: productNextCommand,
      },
    );
    if (result.ok && productResultFailed(result.value)) process.exitCode = 1;
  } catch (cause) {
    process.exitCode = emitError(name, fromUnknown(cause, "ARTIFACT_INVALID"), {
      json: isJson(opts),
    });
  }
}

function productCommandMode(name: string, opts: ProductOptions): Result<void> {
  if (
    name === "brief" &&
    [opts.template, opts.from !== undefined, opts.patch !== undefined].filter(Boolean).length > 1
  )
    return err(
      vispError("ARTIFACT_INVALID", "--template, --from and --patch are mutually exclusive"),
    );
  if (name === "review")
    return validateProductReviewRequest({
      ...opts,
      assessments: opts.from !== undefined ? [] : undefined,
    });
  if (
    opts.checkTemplate !== undefined &&
    (opts.template || opts.from !== undefined || opts.patch !== undefined)
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "--check-template cannot be combined with --template, --from or --patch",
      ),
    );
  if (opts.template && opts.from)
    return err(vispError("ARTIFACT_INVALID", "--template and --from are mutually exclusive"));
  return { ok: true, value: undefined };
}

export function featureCommand(): Command {
  return new Command("feature")
    .description("Start a product brief from the original request")
    .argument("<goal>")
    .option("--source-brief <text>", "Preserve the original request verbatim; - reads stdin")
    .option("--risk <level>", "Project risk: low, medium, high, critical", "low")
    .option("--branch", "Create a feature branch")
    .option("--workflow <mode>", "Deprecated full/compact option; both use the product loop")
    .action(async (goal: string, _flags: unknown, cmd: Command) => {
      const opts = options<
        ProductOptions & {
          sourceBrief?: string;
          branch?: boolean;
          risk?: string;
          workflow?: string;
        }
      >(cmd);
      const risk = parseRiskLevel(opts.risk ?? "low");
      const mode = opts.workflow ? parseWorkflowMode(opts.workflow) : undefined;
      if (!risk.ok || (mode && !mode.ok)) {
        process.exitCode = emitError(
          "feature",
          !risk.ok
            ? risk.error
            : (mode as { ok: false; error: import("../../core/errors.js").VispError }).error,
          { json: isJson(opts) },
        );
        return;
      }
      await execute("feature", opts, true, async (state) =>
        createProductFeatureWithTests(
          state,
          {
            goal,
            // Long requests with quotes are hard to pass as one shell argument.
            sourceBrief:
              opts.sourceBrief === "-"
                ? (await readStandardInput()).toString("utf8")
                : opts.sourceBrief,
            branch: opts.branch,
            riskLevel: risk.value,
          },
          configuredTestsStarter(state),
        ),
      );
    });
}

export function briefCommand(): Command {
  return command(
    "brief",
    "Read or update the single authored working brief",
    false,
    async (state, opts) => {
      if (opts.checkTemplate !== undefined)
        return productCheckTemplate(state, opts.checkTemplate, opts);
      if (opts.template) return productInputTemplate(state, "brief", opts);
      if (opts.from === undefined && opts.patch === undefined) return readProductBrief(state, opts);
      return updateProductBrief(state, {
        feature: opts.feature,
        ...(opts.patch !== undefined
          ? { patch: await readCommandInput(state, opts.patch) }
          : { brief: await readCommandInput(state, opts.from ?? "-") }),
        reason: opts.reason,
        ...(opts.intentChange
          ? {
              intentChange: {
                reason: opts.intentChange,
                provenance: opts.provenance ?? "operator-reported",
              },
            }
          : {}),
      });
    },
    false,
  )
    .option("--from <path>", "Read YAML or JSON; use - for stdin")
    .option(
      "--patch <path>",
      "Merge changed fields; arrays update by id, omitted ids append; use - for stdin",
    )
    .option("--template", "Print current editable brief without changing state")
    .option("--check-template <kind>", "Editable command or browser check example; no execution")
    .option("--reason <text>", "Why the approach or brief changed")
    .option(
      "--intent-change <reason>",
      "Explicitly rebaseline outcomes; records a claim of authorization",
    )
    .option(
      "--provenance <text>",
      "Origin of the intent-change decision; not proof of human identity",
    )
    .addHelpText(
      "after",
      `\n${BRIEF_INPUT_HELP}\n${PRODUCT_BRIEF_ENTRY_GUIDE}\nIn --json mode, the editable object is inside the envelope's \`data\`; submit the object itself. Every check must be linked in that slice before running visp work or visp done.\nPrefer changed fields via stdin: visp brief --patch - --reason "<why>". Arrays update by id and preserve omitted entries; use --from for a full replacement.`,
    );
}

export const workCommand = () =>
  command("work", "Deliver context and authorize the next usable slice", true, (state, opts) =>
    opts.writeTests && opts.feature
      ? writeIndependentTests(state, opts.feature, codexTester())
      : opts.inspect
        ? runProductContext(state, opts)
        : runProductWork(state, opts, configuredTestsStarter(state), testsWaitMs(state, "cli")),
  )
    .option("--inspect", "Read context without authorization, environment probing or graph refresh")
    .option(
      "--check <command>",
      "Test command for the slice; on a feature without slices, work the whole request as one slice",
    )
    // Internal: the detached process `work` starts to write independent acceptance tests.
    .addOption(new Option("--write-tests").hideHelp());
export const nextCommand = () =>
  command("next", "Show the next product action without modifying state", false, (state, opts) =>
    runProductNextAfterReview(state, opts),
  );
export const statusCommand = () =>
  command(
    "status",
    "Show outcomes, progress, evidence and unresolved review",
    false,
    runProductStatus,
  );
export const verifyCommand = () =>
  command("verify", "Run the selected slice's behavior checks", true, runProductVerify);
export const doneCommand = () =>
  command("done", "Check, review and close the selected slice", true, (state, opts) =>
    runProductDoneReviewed(state, opts, configuredReviewStarter(state), reviewWaitMs(state, "cli")),
  );
export const acceptCommand = () =>
  command("accept", "Check the assembled product against preserved outcomes", true, (state, opts) =>
    runProductAcceptReviewed(
      state,
      opts,
      configuredReviewStarter(state),
      reviewWaitMs(state, "cli"),
    ),
  );
export const prCommand = () =>
  command("pr", "Generate the reviewer handoff from current evidence", false, runProductReport);
export const handoffCommand = () =>
  command("handoff", "Show the current product handoff", false, runProductStatus);
export const migrateCommand = () =>
  command(
    "migrate",
    "Transactionally replace a legacy feature workflow",
    true,
    runProductMigrate,
    false,
  ).option("--dry-run", "Preview migration without changing files");

export function reproduceCommand(): Command {
  return command(
    "reproduce",
    "Link an executed failure to an unresolved finding before repair",
    true,
    (state, opts) =>
      runProductReproduction(state, {
        feature: opts.feature,
        task: opts.task,
        finding: opts.finding,
        execution: opts.execution,
        explanation: opts.reason,
      }),
  )
    .requiredOption("--finding <id>", "Unresolved functional finding ID")
    .requiredOption("--execution <id>", "Current failed behavioral execution ID from verify")
    .requiredOption(
      "--reason <text>",
      "Explain how this failure reproduces the finding; reviewer assessment is still required",
    )
    .addHelpText(
      "after",
      "Run the declared check first, then attach its failed execution before editing the product. This command links existing evidence; it does not execute a check or resolve a finding. After repair, rerun the same check and a relevant adjacent check, then request assessment.",
    );
}

export function reviewCommand(): Command {
  return command(
    "review",
    "Inspect the review bundle or record judgments against actual evidence",
    false,
    async (state, opts) => {
      const request = { ...opts, groups: opts.group };
      if (!opts.from) return runProductReviewRequest(state, request);
      const parsed = parseReviewSubmission(await readCommandInput(state, opts.from), opts.session);
      return parsed.ok ? runProductReviewRequest(state, { ...request, ...parsed.value }) : parsed;
    },
  )
    .option(
      "--prepare",
      "Create a tool-owned review session and return packet/response paths; no model starts",
    )
    .option("--session <id>", "Submit judgments for a prepared session; VISP supplies identity")
    .option(
      "--dispatch",
      "Use an attached host reviewer; record an explicit gap when this CLI has no host adapter",
    )
    .option(
      "--from <path>",
      "YAML or JSON reviewer assessments; - reads stdin; omit to read review",
    )
    .option("--template", "Print editable judgments and generated example coverage")
    .option(
      "--handoff",
      "Prepare a fresh reviewer context for the configured host model; no model is started",
    )
    .option("--group <ids...>", "Deliver selected coherent image groups from the review bundle")
    .option("--detail", "Return the full review bundle after submitting judgments")
    .addHelpText(
      "after",
      `
Prefer visp review --prepare, then read packetPath and its actual images. Submit
the packet's judgments with --session <id> --from -; VISP supplies identity, so
do not add subjectDigest, selection or captures to a prepared-session response.

For legacy --template submissions, read visp review --json. Current evidence identifiers
are in data.evidence and data.sources. Keep subjectDigest and selection from that
bundle in the submission; they bind judgments to the current product.

Check aliases such as C001 resolve only after the declared check has executed via
visp verify or visp done. Submit the editable data object, not the --json envelope.
Use stdin or a draft outside the product tree, for example
.visp/drafts/review.json. Files created or changed in the product tree change its
subject and make a previous review stale.

Use reviewer.context=current unless a genuinely fresh reviewer performed the
review. Do not submit canned satisfied judgments; preserve unclear, unavailable
and failed results with the evidence that supports them.

--dispatch needs an attached host adapter; retrying it cannot start a reviewer.
If no adapter is available, send --handoff to a reviewer through your host, or
perform a current-context review of the bundle and submit a completed --template
through --from -. Missing fresh-context dispatch does not prevent current-context
review; missing review or evidence must still remain unresolved.
`,
    );
}
