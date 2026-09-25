import { Command } from "commander";
import type { UserFeedbackHost } from "../../workflow/product/user-feedback.js";
import { runProductUserFeedback } from "../../workflow/product/user-feedback.js";
import { type GlobalOptions, isJson, mutatingWorkspace, options, workspace } from "../context.js";
import { emit } from "../output.js";

export function userFeedbackCommand(host?: UserFeedbackHost, signal?: AbortSignal) {
  return new Command("feedback")
    .description("Ask the user for advisory feedback during implementation; no critic model call")
    .option("--feature <id>")
    .option("--task <id>")
    .option(
      "--ask <question>",
      "Ask one focused question through the host or return a native popup handoff",
    )
    .option("--context <text>", "Short description of the current behavior or preview to inspect")
    .option("--id <id>", "Pending request returned by ask")
    .option("--reply <text>", "Record the user's verbatim feedback; never an actor-written answer")
    .option("--defer", "Record that this question is deferred; no approval is inferred")
    .action(async (_flags, command: Command) => {
      const opts = options<
        GlobalOptions & {
          feature?: string;
          task?: string;
          ask?: string;
          context?: string;
          id?: string;
          reply?: string;
          defer?: boolean;
        }
      >(command);
      if (
        [opts.ask !== undefined, opts.reply !== undefined, !!opts.defer].filter(Boolean).length > 1
      )
        throw new Error("Choose ask, reply or defer");
      const operation =
        opts.ask !== undefined
          ? "ask"
          : opts.reply !== undefined
            ? "reply"
            : opts.defer
              ? "defer"
              : "status";
      const state = await (operation === "status" ? workspace(opts) : mutatingWorkspace(opts));
      const result = state.ok
        ? await runProductUserFeedback(
            state.value,
            {
              operation,
              feature: opts.feature,
              task: opts.task,
              question: opts.ask,
              context: opts.context,
              id: opts.id,
              reply: opts.reply,
            },
            host,
            signal,
          )
        : state;
      process.exitCode = emit<unknown>("user-feedback", result, {
        json: isJson(opts),
        text: (value) => JSON.stringify(value, null, 2),
      });
    });
}
