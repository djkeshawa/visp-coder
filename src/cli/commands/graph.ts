import { Command } from "commander";
import { PRODUCT_NAME } from "../../core/constants.js";
import {
  type IndexReport,
  indexRepository,
  openProjectStore,
  QUERY_OPERATIONS,
  type QueryEnvelope,
  type QueryOperation,
  queryGraph,
  refreshRepository,
} from "../../graph/index.js";
import { resolveQueryInput } from "../../graph/query/arguments.js";
import { queryFreshnessNote } from "../../graph/query/index.js";
import { type AnswerStyle, renderQueryAnswer } from "../../graph/query/render.js";
import { recordActivity, recordActivityLater } from "../../orchestrate/session.js";
import { isJson, mutatingWorkspace, options, workspace } from "../context.js";
import { emit, emitError } from "../output.js";

export function indexCommand(): Command {
  return new Command("index")
    .description("Build or refresh the repository index")
    .option("--refresh", "Re-index only what changed since the last run")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<{ refresh?: boolean }>(command);
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("index", state.error, { json: isJson(opts) });
        return;
      }

      const build = opts.refresh ? refreshRepository : indexRepository;
      const result = await build(
        state.value.paths.root,
        state.value.config.graph,
        state.value.paths.graphStore,
      );

      if (result.ok) {
        await recordActivity(state.value, {
          command: opts.refresh ? "index --refresh" : "index",
          outcome: "ok",
          detail: `${result.value.counts.entities} entities, ${result.value.counts.relations} relations`,
        });
      }

      process.exitCode = emit("index", result, {
        json: isJson(opts),
        text: (report) => renderIndexReport(report),
        nextCommand: () => `${PRODUCT_NAME} next`,
      });
    });
}

function renderIndexReport(report: IndexReport): string {
  if (report.noChange) return "Nothing changed, so nothing was re-parsed.";

  const lines = [
    `Indexed ${report.counts.files} files (${report.filesParsed} parsed, ${report.filesReused} reused): ` +
      `${report.counts.entities} entities, ${report.counts.relations} relations.`,
  ];

  if (report.languageCoverage.length > 0) {
    lines.push(
      "",
      ...report.languageCoverage.map(
        (entry) =>
          `  ${entry.language.padEnd(12)} ${entry.parsedFiles}/${entry.totalFiles} files parsed`,
      ),
    );
  }

  // An empty graph and an unreadable repository look alike without this.
  if (report.counts.entities === 0) {
    lines.push(
      "",
      "No entities were extracted. Graph queries are empty for unsupported languages such as Go and Rust; graph.languages supports TypeScript, JavaScript and Python.",
    );
  }

  if (report.counts.unknowns > 0) {
    lines.push(
      "",
      `${report.counts.unknowns} things could not be determined. See: ${PRODUCT_NAME} query unknowns`,
    );
  }

  return lines.join("\n");
}

export function queryCommand(): Command {
  return new Command("query")
    .description("Ask a bounded structural question about the repository")
    .argument("<operation>", `One of: ${QUERY_OPERATIONS.join(", ")}`)
    .argument("[target]", "Entity id, file path, or search text, depending on the operation")
    .argument("[to]", "Destination entity or path for tracePath")
    .option("--depth <n>", "How far to traverse", Number.parseInt)
    .option("--results <n>", "How many rows to return", Number.parseInt)
    .option("--nodes <n>", "Maximum nodes visited during traversal", Number.parseInt)
    .option("--edges <n>", "Maximum edges examined during traversal", Number.parseInt)
    .action(
      async (
        operation: string,
        target: string | undefined,
        to: string | undefined,
        _flags: unknown,
        command: Command,
      ) => {
        const opts = options<{ depth?: number; results?: number; nodes?: number; edges?: number }>(
          command,
        );

        if (!QUERY_OPERATIONS.includes(operation as QueryOperation)) {
          process.exitCode = emitError(
            "query",
            {
              code: "UNSUPPORTED",
              message: `Unknown operation: ${operation}`,
              recovery: `Use one of: ${QUERY_OPERATIONS.join(", ")}`,
            },
            { json: isJson(opts) },
          );
          return;
        }

        const state = await workspace(opts);
        if (!state.ok) {
          process.exitCode = emitError("query", state.error, { json: isJson(opts) });
          return;
        }

        const store = await openProjectStore(state.value.files, state.value.paths.graphStore);
        if (!store.ok) {
          process.exitCode = emitError("query", store.error, { json: isJson(opts) });
          return;
        }

        try {
          const resolved = resolveQueryInput(store.value, operation as QueryOperation, target, to);
          if (!resolved.ok) {
            process.exitCode = emitError("query", resolved.error, { json: isJson(opts) });
            return;
          }
          const result = queryGraph(store.value, operation as QueryOperation, resolved.value.args, {
            depth: opts.depth,
            results: opts.results,
            nodes: opts.nodes,
            edges: opts.edges,
          });

          // Whether agents ever ask the index anything was unanswerable for
          // every finished run: only `done` reached the trail.
          if (result.ok) {
            result.value.notes.unshift(...resolved.value.notes);
            const freshness = await queryFreshnessNote(store.value, state.value.paths.root);
            if (freshness) result.value.notes.push(freshness);
            recordActivityLater(state.value, {
              command: "query",
              outcome: "ok",
              detail: [operation, target].filter(Boolean).join(" "),
            });
          }

          process.exitCode = emit("query", result, {
            json: isJson(opts),
            text: renderAnswer,
          });
        } finally {
          store.value.close();
        }
      },
    );
}

const CLI_ANSWER: AnswerStyle = {
  indent: "  ",
  summaryLine: (key, value) => `  ${key.padEnd(18)} ${format(value)}`,
  truncationHint,
};

function renderAnswer(answer: QueryEnvelope): string {
  return renderQueryAnswer(answer, CLI_ANSWER);
}

function format(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(format).join(", ");
  if (typeof value === "object") return describeRecord(value as Record<string, unknown>);
  return String(value);
}

/** `typescript 4/4` reads better than a JSON blob in a terminal summary. */
function describeRecord(record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  const label = entries.find(([key]) => /language|kind|name/.test(key))?.[1];
  const numbers = entries.filter(([, value]) => typeof value === "number");

  if (label !== undefined && numbers.length > 0) {
    return `${String(label)} ${numbers.map(([, value]) => String(value)).join("/")}`;
  }
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(" ");
}

function truncationHint(answer: QueryEnvelope): string {
  return answer.receipt.work?.truncated
    ? "Traversal incomplete; increase --nodes or --edges to investigate further."
    : `Truncated at ${answer.receipt.budget.results} results; ask for more with --results.`;
}
