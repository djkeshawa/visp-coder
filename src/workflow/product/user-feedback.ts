import { randomUUID } from "node:crypto";
import { fromUnknown, vispError } from "../../core/errors.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { observedProduct } from "./critic-status.js";
import type { ProductSlice } from "./model.js";
import { withProductMutation } from "./runtime.js";
import { selectProductSlice } from "./scopes.js";
import { type ProductRecord, readProductRecord, saveProductState } from "./store.js";
import { productContractDigest, productSourceDigest } from "./subject.js";
import {
  type UserFeedbackHost,
  type UserFeedbackPrompt,
  type UserFeedbackRecord,
  type UserFeedbackRequest,
  userFeedbackAnswerSchema,
  userFeedbackRequestSchema,
} from "./user-feedback-model.js";

export type { UserFeedbackHost } from "./user-feedback-model.js";

/** Advisory input. Neither silence nor a positive reply supplies execution/acceptance evidence. */
export function userFeedbackPlan(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  subject: string,
) {
  const entries = (record.state.userFeedback ?? []).filter((entry) => entry.task === slice?.id);
  const latest = entries.at(-1);
  const enabled = record.state.criticManual === true;
  if (!enabled && !latest) return undefined;
  const due = enabled && !latest && observedProduct(workspace, record, slice, subject);
  return {
    enabled,
    status: latest?.status ?? (due ? "suggested" : "awaiting-usable-slice"),
    request: enabled && latest?.status === "pending" ? handoff(record, latest, false) : undefined,
    feedback: entries
      .filter((entry) => entry.status === "answered")
      .slice(-3)
      .map((entry) => ({
        id: entry.id,
        question: entry.question,
        reply: entry.reply,
        provenance: entry.provenance,
        current:
          entry.subject === subject && entry.contract === productContractDigest(record.brief),
      })),
    omittedFeedback: Math.max(0, entries.filter((entry) => entry.status === "answered").length - 3),
    command: due
      ? `visp critic feedback --feature ${record.brief.feature}${slice ? ` --task ${slice.id}` : ""} --ask "Does this first usable version match what you wanted? What should I improve next?"`
      : undefined,
    guidance:
      "At the first usable slice, ask through the coding tool's user-question interface before expanding. A consequential design uncertainty can be asked earlier. Show the relevant UI or behavior and use one focused, open question. Continue unrelated work while waiting; do not repeat a pending or deferred question. Apply useful feedback or clarify ambiguity, then observe the change. User feedback is advisory input, not a passing check or an automatic intent change. Older feedback remains context, not assessment of changed source.",
  };
}

export async function runProductUserFeedback(
  workspace: WorkspaceState,
  input: unknown,
  host?: UserFeedbackHost,
  signal?: AbortSignal,
) {
  const parsed = userFeedbackRequestSchema.safeParse(input);
  if (!parsed.success) return err(vispError("ARTIFACT_INVALID", parsed.error.message));
  const request = parsed.data;
  const invalid = invalidRequest(request);
  if (invalid) return err(vispError("ARTIFACT_INVALID", invalid));
  if (signal?.aborted) return err(vispError("STATE_BUSY", "User feedback request cancelled"));
  if (request.operation === "status") return feedbackStatus(workspace, request);
  const prepared = await withProductMutation(workspace, () =>
    mutateFeedback(workspace, request, !!host),
  );
  if (!prepared.ok || !host || request.operation !== "ask" || !prepared.value.dispatch)
    return prepared;
  // Never hold the workspace mutation lock while a person is deciding.
  const prompt = prepared.value.prompt;
  try {
    const answer = userFeedbackAnswerSchema.parse(await askWithCancellation(host, prompt, signal));
    if (signal?.aborted)
      throw new Error("User feedback request interrupted; reply remains unknown");
    const followup = userFeedbackRequestSchema.parse({
      feature: prepared.value.feature,
      task: prepared.value.task,
      id: prompt.id,
      operation: answer.action === "answer" ? "reply" : "defer",
      ...(answer.action === "answer" ? { reply: answer.text } : {}),
    });
    return await withProductMutation(workspace, () =>
      mutateFeedback(workspace, followup, false, "host-elicited"),
    );
  } catch (cause) {
    return withProductMutation(workspace, () =>
      recordDeliveryIssue(
        workspace,
        { ...request, feature: prepared.value.feature, task: prepared.value.task },
        prompt.id,
        fromUnknown(cause).message,
      ),
    );
  }
}

async function askWithCancellation(
  host: UserFeedbackHost,
  prompt: UserFeedbackPrompt,
  signal?: AbortSignal,
) {
  if (!signal) return host.ask(prompt, {});
  let cancel: () => void = () => {};
  try {
    return await Promise.race([
      host.ask(prompt, { signal }),
      new Promise<never>((_resolve, reject) => {
        cancel = () =>
          reject(new Error("User feedback request interrupted; no automatic re-prompt"));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function invalidRequest(request: UserFeedbackRequest) {
  if (request.operation === "ask") {
    if (!request.question || request.id || request.reply)
      return "ask requires a question; omit id and reply";
  } else if (request.question || request.context) return "question/context belong to ask";
  if (request.operation === "reply" && (!request.id || !request.reply))
    return "reply requires id and the user's verbatim feedback";
  if (request.operation === "defer" && (!request.id || request.reply))
    return "defer requires id and no reply";
  if (request.operation === "status" && (request.id || request.reply))
    return "status is read-only; omit id and reply";
  return undefined;
}

async function selectedFeedback(workspace: WorkspaceState, request: UserFeedbackRequest) {
  const loaded = await readProductRecord(workspace, request);
  if (!loaded.ok) return loaded;
  const slice = selectProductSlice(workspace, loaded.value, request, true);
  return slice.ok ? ok({ record: loaded.value, slice: slice.value }) : slice;
}

async function feedbackStatus(workspace: WorkspaceState, request: UserFeedbackRequest) {
  const selected = await selectedFeedback(workspace, request);
  if (!selected.ok) return selected;
  const subject = await productSourceDigest(workspace, selected.value.record.brief);
  return subject.ok
    ? ok(
        userFeedbackPlan(workspace, selected.value.record, selected.value.slice, subject.value) ?? {
          enabled: false,
        },
      )
    : subject;
}

async function mutateFeedback(
  workspace: WorkspaceState,
  request: UserFeedbackRequest,
  attached: boolean,
  provenance: UserFeedbackRecord["provenance"] = "caller-reported",
) {
  const selected = await selectedFeedback(workspace, request);
  if (!selected.ok) return selected;
  const { record, slice } = selected.value;
  if (record.state.status === "historical-complete")
    return err(vispError("STAGE_BLOCKED", "Historical features are read-only"));
  const entries = record.state.userFeedback ?? [];
  if (request.operation !== "ask")
    return recordReply(workspace, record, slice, request, provenance);
  if (!record.state.criticManual)
    return err(
      vispError(
        "CONFIG_INVALID",
        "Manual feedback is off. Enable critic --mode manual or --mode both at the user's request.",
      ),
    );
  const pending = entries.find((entry) => entry.task === slice?.id && entry.status === "pending");
  if (pending) return ok(handoff(record, pending, false));
  const subject = await productSourceDigest(workspace, record.brief);
  if (!subject.ok) return subject;
  const entry: UserFeedbackRecord = {
    id: randomUUID(),
    task: slice?.id,
    question: request.question as string,
    context: request.context,
    subject: subject.value,
    contract: productContractDigest(record.brief),
    createdAt: new Date().toISOString(),
    status: "pending",
    provenance: "caller-reported",
    ...(attached ? { dispatchClaimed: true } : {}),
  };
  const saved = await saveProductState(workspace, record, {
    ...record.state,
    userFeedback: [...entries, entry],
  });
  return saved.ok ? ok(handoff(record, entry, attached)) : saved;
}

async function recordReply(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  request: UserFeedbackRequest,
  provenance: UserFeedbackRecord["provenance"],
) {
  const entry = record.state.userFeedback?.find(
    (item) => item.id === request.id && item.task === slice?.id,
  );
  if (entry?.status !== "pending")
    return err(
      vispError("STATE_BUSY", "No pending feedback request matches this selection and id"),
    );
  const next: UserFeedbackRecord = {
    ...entry,
    status: request.operation === "reply" ? "answered" : "deferred",
    reply: request.reply,
    respondedAt: new Date().toISOString(),
    provenance,
  };
  const saved = await saveProductState(workspace, record, {
    ...record.state,
    userFeedback: record.state.userFeedback?.map((item) => (item.id === entry.id ? next : item)),
  });
  return saved.ok ? ok(handoff(record, next, false)) : saved;
}

async function recordDeliveryIssue(
  workspace: WorkspaceState,
  request: UserFeedbackRequest,
  id: string,
  message: string,
) {
  const selected = await selectedFeedback(workspace, request);
  if (!selected.ok) return selected;
  const record = selected.value.record;
  const entry = record.state.userFeedback?.find((item) => item.id === id);
  if (!entry) return err(vispError("STATE_BUSY", "Feedback request disappeared"));
  if (entry.status !== "pending") return ok(handoff(record, entry, false));
  const next = { ...entry, deliveryIssue: message };
  const saved = await saveProductState(workspace, record, {
    ...record.state,
    userFeedback: record.state.userFeedback?.map((item) => (item.id === id ? next : item)),
  });
  return saved.ok ? ok(handoff(record, next, false)) : saved;
}

function handoff(record: ProductRecord, entry: UserFeedbackRecord, dispatch: boolean) {
  const base = `visp critic feedback --feature ${record.brief.feature}${entry.task ? ` --task ${entry.task}` : ""} --id ${entry.id}`;
  return {
    feature: record.brief.feature,
    task: entry.task,
    id: entry.id,
    status: entry.status,
    dispatch,
    prompt: {
      id: entry.id,
      originalRequest: record.brief.originalRequest,
      objective:
        record.brief.slices.find((slice) => slice.id === entry.task)?.goal ?? record.brief.goal,
      question: entry.question,
      context: entry.context,
    },
    reply: entry.reply,
    provenance: entry.provenance,
    deliveryIssue: entry.deliveryIssue,
    delivery: entry.dispatchClaimed ? "attached-user-question" : "native-handoff",
    next:
      entry.status === "pending"
        ? "Use the coding tool's user-question popup (Codex request_user_input_async or request_user_input when available, Claude AskUserQuestion, or the host's equivalent); show the relevant preview/images separately. Reuse this pending request rather than asking twice. If no question tool is available, ask once in conversation. Submit the user's actual words; never fill an answer on their behalf. Continue unrelated work while waiting."
        : "Use the feedback to choose the next useful change, then observe the result. No automatic acceptance or requirement edits were made.",
    submit: `${base} --reply <verbatim-user-feedback>`,
    defer: `${base} --defer`,
  };
}
