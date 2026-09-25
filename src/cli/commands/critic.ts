import { Command } from "commander";
import { fromUnknown } from "../../core/errors.js";
import { type CriticAdapter, runProductCritic } from "../../workflow/product/critic.js";
import { configuredCriticLauncher } from "../../workflow/product/critic-exec.js";
import { rejectedCriticReview } from "../../workflow/product/critic-status.js";
import type { UserFeedbackHost } from "../../workflow/product/user-feedback.js";
import { type GlobalOptions, isJson, mutatingWorkspace, options, workspace } from "../context.js";
import { readCommandInput } from "../input.js";
import { emit, emitError, emitRefusal } from "../output.js";
import { criticDefaultsCommand } from "./critic-defaults.js";
import { userFeedbackCommand } from "./user-feedback.js";

export function criticCommand(
  host?: CriticAdapter,
  signal?: AbortSignal,
  userHost?: UserFeedbackHost,
): Command {
  return new Command("critic")
    .description("Bounded product critic; status/preflight are read-only")
    .addCommand(criticDefaultsCommand())
    .addCommand(userFeedbackCommand(userHost, signal))
    .option("--mode <mode>", "auto, manual, both, or off for this feature")
    .option("--feature <id>")
    .option("--task <id>")
    .option(
      "--question <text>",
      "Question for the independent reviewer; not an expected conclusion",
    )
    .option(
      "--phase <phase>",
      "understanding before implementation, or product (default); shares the selection's call budget",
    )
    .option("--on", "Enable critic for the whole feature, preserving spent attempts")
    .option("--off", "Disable critic for the whole feature, preserving findings and history")
    .option("--harness <name>", "Reviewer host when enabling an unconfigured feature")
    .option(
      "--reason <text>",
      "Reason for policy, intent reconciliation, or explicit failure recovery",
    )
    .option(
      "--retry-after <id>",
      "Explicit fresh attempt after a resolved failure; use with preflight/prepare/dispatch and reason",
    )
    .option(
      "--not-invoked",
      "Host reports failure before invocation; not proof and never inferred from a failure string",
    )
    .option("--configure <path>", "Explicit model and limits in JSON/YAML; - reads stdin")
    .option(
      "--source-only",
      "Source advice without product approval; shares the critic call budget",
    )
    .option("--preflight", "Inspect native host requirements without reserving a call")
    .option("--prepare", "Reserve one native review and generate its packet")
    .option("--capabilities <path>", "Host-reported capabilities in JSON/YAML; - reads stdin")
    .option(
      "--submit <path>",
      "Reviewer JSON with --attempt and --capabilities, or legacy envelope; - reads stdin",
    )
    .option(
      "--failure <reason>",
      "Record host failure for --attempt; omit attempt with --phase understanding for an unavailable preflight",
    )
    .option("--attempt <id>", "Prepared attempt identity for submitting unchanged reviewer JSON")
    .option(
      "--failure-kind <category>",
      "host-unavailable, permission-denied, model-unavailable, image-unavailable, invocation-failed, schema-rejected, or setup-unverified",
    )
    .option("--reconcile", "Reconcile a validated brief revision, preserving calls and history")
    .option("--dispatch", "Review using an attached host (standalone CLI returns native handoff)")
    .option("--restore <id>", "Restore candidate source within current authorized scope")
    .option("--expected-subject <hash>", "Guard restoration against concurrent source changes")
    .option("--disable", "Retired: use whole-feature --off only at the user’s request")
    .action(async (_flags, cmd: Command) => {
      const opts = options<
        GlobalOptions & {
          feature?: string;
          task?: string;
          phase?: string;
          question?: string;
          sourceOnly?: boolean;
          mode?: string;
          on?: boolean;
          off?: boolean;
          harness?: string;
          reason?: string;
          configure?: string;
          dispatch?: boolean;
          preflight?: boolean;
          prepare?: boolean;
          capabilities?: string;
          submit?: string;
          attempt?: string;
          failure?: string;
          failureKind?: string;
          retryAfter?: string;
          notInvoked?: boolean;
          reconcile?: boolean;
          restore?: string;
          expectedSubject?: string;
          disable?: boolean;
        }
      >(cmd);
      try {
        const operation = criticOperation(opts);
        const state = await (["status", "preflight"].includes(operation)
          ? workspace(opts)
          : mutatingWorkspace(opts));
        if (!state.ok) {
          process.exitCode = emitError("critic", state.error, { json: isJson(opts) });
          return;
        }
        const result = await runProductCritic(
          state.value,
          {
            operation,
            feature: opts.feature,
            task: opts.task,
            phase: opts.phase,
            question: opts.question,
            sourceOnly: opts.sourceOnly,
            enabled: operation === "set-policy" && opts.mode === undefined ? !!opts.on : undefined,
            mode: opts.mode,
            harness: opts.harness,
            reason: opts.reason,
            ...(await readCriticField(state.value, "config", opts.configure)),
            ...(await readCriticField(state.value, "capabilities", opts.capabilities)),
            ...(await readCriticField(
              state.value,
              opts.attempt ? "response" : "result",
              opts.submit,
            )),
            attempt: opts.attempt,
            failure: opts.failure,
            failureKind: opts.failureKind,
            retryAfter: opts.retryAfter,
            notInvoked: opts.notInvoked,
            candidate: opts.restore,
            expectedSubject: opts.expectedSubject,
          },
          reviewerFor(host, state.value),
          signal,
        );
        if (
          result.ok &&
          (opts.submit !== undefined || opts.dispatch) &&
          rejectedCriticReview(result.value)
        ) {
          process.exitCode = emitRefusal(
            "critic",
            result.value,
            `Critic review was not accepted. No automatic retry; inspect the retained reason and continue host review.\n${JSON.stringify(result.value, null, 2)}`,
            { json: isJson(opts) },
          );
          return;
        }
        process.exitCode = emit("critic", result, {
          json: isJson(opts),
          text: (value) => JSON.stringify(value, null, 2),
        });
      } catch (cause) {
        process.exitCode = emitError("critic", fromUnknown(cause, "ARTIFACT_INVALID"), {
          json: isJson(opts),
        });
      }
    });
}

/** An attached host wins; otherwise the reviewer the project lets VISP launch, if any. */
function reviewerFor(
  host: CriticAdapter | undefined,
  state: Parameters<typeof configuredCriticLauncher>[0],
): CriticAdapter | undefined {
  return host ?? configuredCriticLauncher(state);
}

function criticOperation(opts: {
  mode?: string;
  reconcile?: boolean;
  configure?: string;
  dispatch?: boolean;
  preflight?: boolean;
  prepare?: boolean;
  submit?: string;
  failure?: string;
  restore?: string;
  disable?: boolean;
  on?: boolean;
  off?: boolean;
}) {
  if (opts.mode !== undefined && (opts.on || opts.off)) throw new Error("Choose mode or on/off");
  if (opts.on && opts.off) throw new Error("Choose --on or --off");
  const choices: [string, boolean | undefined][] = [
    ["set-policy", opts.mode !== undefined || opts.on || opts.off],
    ["configure", opts.configure !== undefined],
    ["reconcile", opts.reconcile],
    ["review", opts.dispatch],
    ["preflight", opts.preflight],
    ["prepare", opts.prepare],
    ["submit", opts.submit !== undefined || opts.failure !== undefined],
    ["restore", opts.restore !== undefined],
    ["disable", opts.disable],
  ];
  const operations = choices.filter(([, selected]) => selected).map(([operation]) => operation);
  if (operations.length > 1) throw new Error("Choose one critic operation");
  return operations[0] ?? "status";
}

async function readCriticField(
  state: import("../../workflow/state.js").WorkspaceState,
  key: string,
  path: string | undefined,
) {
  if (path === undefined) return {};
  try {
    return { [key]: await readCommandInput(state, path) };
  } catch (cause) {
    if (!["response", "result"].includes(key)) throw cause;
    throw new Error(
      `Reviewer response could not be read: ${fromUnknown(cause).message}. VISP has not consumed the reservation or edited the response. Preserve the original output. Submit an intact valid response from the same invocation, or report --attempt <id> --failure <actual-response-error>; do not relaunch the critic or rewrite its judgments to make validation pass.`,
    );
  }
}
