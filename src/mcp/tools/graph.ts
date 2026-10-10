import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PRODUCT_NAME } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { err, type Result } from "../../core/result.js";
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
import { loadWorkspace, loadWorkspaceForMutation } from "../../workflow/state.js";
import { TOOL } from "../constants.js";
import { failure, reply } from "../reply.js";

/**
 * Structural questions about the repository. These are what let an agent find
 * the blast radius of a change without reading its way there.
 */
export function registerGraphTools(server: McpServer, root: string): void {
  registerQuery(server, root);
  registerIndex(server, root);
}

const queryInput = {
  operation: z
    .enum(QUERY_OPERATIONS)
    .describe("Which question to ask about the repository structure"),
  target: z
    .string()
    .optional()
    .describe("A symbol name, an entity id, or a file path, depending on the operation"),
  to: z.string().optional().describe("Destination entity or path for tracePath"),
  depth: z.number().int().positive().optional().describe("How far to traverse"),
  results: z.number().int().positive().optional().describe("How many rows to return"),
  nodes: z.number().int().positive().optional().describe("Maximum nodes visited during traversal"),
  edges: z.number().int().positive().optional().describe("Maximum edges examined during traversal"),
};

function registerQuery(server: McpServer, root: string): void {
  server.registerTool(
    TOOL.query,
    {
      title: "Query the repository index",
      description:
        "Ask a bounded structural question about definitions, callers, tests or impact. Search matches entity names or a file's declarations, not source text; use host text search for body strings. Index first.",
      inputSchema: queryInput,
    },
    async (args) => {
      const answer = await runQuery(root, args);
      return reply(TOOL.query, answer, { text: renderAnswer });
    },
  );
}

async function runQuery(
  root: string,
  args: {
    operation: QueryOperation;
    target?: string;
    to?: string;
    depth?: number;
    results?: number;
    nodes?: number;
    edges?: number;
  },
): Promise<Result<QueryEnvelope>> {
  const state = await loadWorkspace(root);
  if (!state.ok) return state;

  const graphStore = await state.value.files.exists(state.value.paths.graphStore);
  if (!graphStore.ok) return graphStore;
  if (!graphStore.value) {
    return err(
      vispError("GRAPH_MISSING", "The repository has not been indexed yet", {
        recovery: `${PRODUCT_NAME} index`,
      }),
    );
  }

  const store = await openProjectStore(state.value.files, state.value.paths.graphStore);
  if (!store.ok) return store;

  try {
    const resolved = resolveQueryInput(store.value, args.operation, args.target, args.to);
    if (!resolved.ok) return resolved;
    const answer = queryGraph(store.value, args.operation, resolved.value.args, {
      ...(args.depth !== undefined ? { depth: args.depth } : {}),
      ...(args.results !== undefined ? { results: args.results } : {}),
      ...(args.nodes !== undefined ? { nodes: args.nodes } : {}),
      ...(args.edges !== undefined ? { edges: args.edges } : {}),
    });
    if (answer.ok) {
      const freshness = await queryFreshnessNote(store.value, state.value.paths.root);
      if (freshness) answer.value.notes.push(freshness);
      recordActivityLater(state.value, {
        command: "query",
        outcome: "ok",
        detail: [args.operation, args.target].filter(Boolean).join(" "),
      });
      answer.value.notes.unshift(...resolved.value.notes);
    }
    return answer;
  } finally {
    store.value.close();
  }
}

const MCP_ANSWER: AnswerStyle = {
  indent: "",
  summaryLine: (key, value) => `${key}: ${JSON.stringify(value)}`,
  truncationHint: (answer) =>
    answer.receipt.work?.truncated
      ? "Traversal incomplete; increase nodes or edges to investigate further."
      : "Truncated by the result budget.",
};

function renderAnswer(answer: QueryEnvelope): string {
  return renderQueryAnswer(answer, MCP_ANSWER);
}

function registerIndex(server: McpServer, root: string): void {
  server.registerTool(
    TOOL.index,
    {
      title: "Build or refresh the repository index",
      description:
        "Index the repository so structural queries can answer. Use --refresh semantics by passing refresh: true after files change.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Re-index only what changed since the last run"),
        detail: z
          .boolean()
          .optional()
          .describe(
            "Use true for complete changed and skipped path lists; default is a bounded summary",
          ),
      },
    },
    async (args) => {
      const state = await loadWorkspaceForMutation(root);
      if (!state.ok) return failure(TOOL.index, state.error);

      const build = args.refresh ? refreshRepository : indexRepository;
      const report = await build(
        state.value.paths.root,
        state.value.config.graph,
        state.value.paths.graphStore,
      );
      if (report.ok) {
        await recordActivity(state.value, {
          command: args.refresh ? "index --refresh" : "index",
          outcome: "ok",
          detail: `${report.value.counts.entities} entities, ${report.value.counts.relations} relations`,
        });
      }

      return reply(TOOL.index, report, {
        ...(args.detail !== true
          ? {
              data: (value: IndexReport) => ({
                ...value,
                diff: Object.fromEntries(
                  Object.entries(value.diff).map(([kind, paths]) => [
                    kind,
                    kind === "unchanged"
                      ? { count: paths.length }
                      : { count: paths.length, sample: paths.slice(0, 10) },
                  ]),
                ),
                skipped: { count: value.skipped.length, sample: value.skipped.slice(0, 10) },
                detail: "File paths omitted; use detail:true for the complete report",
              }),
            }
          : {}),
        text: (value) =>
          value.noChange
            ? "Nothing changed, so nothing was re-parsed."
            : `Indexed ${value.counts.files} files: ${value.counts.entities} entities, ${value.counts.relations} relations, ${value.counts.unknowns} unknowns.`,
      });
    },
  );
}
