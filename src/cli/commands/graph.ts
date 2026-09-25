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
import { queryArgs, resolveQueryTarget } from "../../graph/query/arguments.js";
import { recordActivity } from "../../orchestrate/session.js";
import { isJson, mutatingWorkspace, options } from "../context.js";
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
      "No entities were extracted. Check that graph.languages in visp.yml covers this project.",
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
    .option("--depth <n>", "How far to traverse", Number.parseInt)
    .option("--results <n>", "How many rows to return", Number.parseInt)
    .option("--nodes <n>", "Maximum nodes visited during traversal", Number.parseInt)
    .option("--edges <n>", "Maximum edges examined during traversal", Number.parseInt)
    .action(
      async (operation: string, target: string | undefined, _flags: unknown, command: Command) => {
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

        const state = await mutatingWorkspace(opts);
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
          const resolved = resolveQueryTarget(store.value, operation as QueryOperation, target);
          if (!resolved.ok) {
            process.exitCode = emitError("query", resolved.error, { json: isJson(opts) });
            return;
          }

          const result = queryGraph(
            store.value,
            operation as QueryOperation,
            queryArgs(operation as QueryOperation, resolved.value),
            {
              depth: opts.depth,
              results: opts.results,
              nodes: opts.nodes,
              edges: opts.edges,
            },
          );

          // Whether agents ever ask the index anything was unanswerable for
          // every finished run: only `done` reached the trail.
          if (result.ok) {
            await recordActivity(state.value, {
              command: "query",
              outcome: "ok",
              detail: [operation, target].filter(Boolean).join(" "),
            });
          }

          process.exitCode = emit("query", result, {
            json: isJson(opts),
            text: (answer) =>
              [
                resolved.value !== target && resolved.value !== undefined
                  ? `Reading ${resolved.value}\n`
                  : "",
                renderAnswer(answer),
              ]
                .filter(Boolean)
                .join(""),
          });
        } finally {
          store.value.close();
        }
      },
    );
}

function renderAnswer(answer: QueryEnvelope): string {
  const lines: string[] = [];

  if (answer.summary) {
    for (const [key, value] of Object.entries(answer.summary)) {
      lines.push(`  ${key.padEnd(18)} ${format(value)}`);
    }
  }

  for (const row of answer.rows) {
    const where = row.startLine === undefined ? row.path : `${row.path}:${row.startLine}`;
    lines.push(`  ${where}  ${row.name}${row.detail ? `  ${row.detail}` : ""}`);
  }

  // For `unknowns` the unknowns *are* the answer, so listing them under a
  // "not determined" aside — after saying there were no results — contradicts
  // itself. Everywhere else they are context alongside the rows.
  const unknownsAreTheAnswer = answer.operation === "unknowns";
  if (answer.unknowns.length > 0) {
    if (unknownsAreTheAnswer) {
      lines.push(
        ...answer.unknowns.map(
          (unknown) => `  ${unknown.kind.padEnd(24)} ${unknown.path}${detailOf(unknown)}`,
        ),
      );
    } else {
      lines.push(
        "",
        "Not determined:",
        ...answer.unknowns.map((unknown) => `  ${unknown.kind} at ${unknown.path}`),
      );
    }
  }

  if (lines.length === 0) lines.push("  no results");

  for (const note of answer.notes) lines.push("", note);

  if (answer.receipt.truncated) {
    lines.push("", truncationHint(answer));
  }

  return lines.join("\n");
}

function detailOf(unknown: { detail?: string }): string {
  return unknown.detail ? `  ${unknown.detail}` : "";
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
