import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { reachesModel, runCodexStructured } from "./critic-exec.js";

/** Chooses, from recorded notes, the ones a new request must stay consistent with. */
export type MemoryGate = (request: string, notes: readonly string[]) => Promise<string[]>;

/**
 * Visp Memory's keyword relevance scored the decisions a request needed and unrelated earlier
 * features alike (0.54–0.57), so a store holding ten earlier features filled the request with
 * noise, including near-miss limits from other endpoints, and dropped a needed decision. Given
 * every candidate, the reviewer's model at low effort chose exactly the three decisions that
 * constrained the request out of 45, in about fourteen seconds, seeing only the notes.
 */
const INSTRUCTIONS = `A user sent the REQUEST below to an AI coding assistant. The NOTES are recorded from the user's earlier requests on the same project. Select only the notes that constrain how THIS request must be implemented: decisions about the same resources, fields, limits or invariants that the requested behavior touches, which the implementation must stay consistent with. Do not select notes that describe other features or endpoints, even if they look similar (for example a limit that the earlier request applied only to a different endpoint), and do not select notes the request itself contradicts. Return {"selected": []} when none apply. Do not read files or run commands.`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selected"],
  properties: {
    selected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["note", "why"],
        properties: { note: { type: "integer" }, why: { type: "string" } },
      },
    },
  },
} as const;
const responseSchema = z.object({
  selected: z.array(z.object({ note: z.number().int(), why: z.string() })),
});

/** Keeps only notes the model named by number, in their original order. */
export function selectedNotes(notes: readonly string[], chosen: readonly number[]): string[] {
  const picked = new Set(chosen.filter((note) => note >= 1 && note <= notes.length));
  return notes.filter((_, index) => picked.has(index + 1));
}

export function codexMemoryGate(options: {
  model: string;
  executable?: string;
  lookup?: (host: string) => Promise<unknown>;
}): MemoryGate {
  return async (request, notes) => {
    if (notes.length === 0) return [];
    const { lookup: dnsLookup } = await import("node:dns/promises");
    if (!(await reachesModel(options.lookup ?? ((host) => dnsLookup(host)))))
      throw new Error("The memory gate cannot reach its model from this process");
    const directory = await mkdtemp(join(tmpdir(), "visp-memory-gate-"));
    try {
      const response = await runCodexStructured({
        ...(options.executable ? { executable: options.executable } : {}),
        root: directory,
        directory,
        model: options.model,
        reasoningEffort: "low",
        schema: RESPONSE_SCHEMA,
        prompt: `${INSTRUCTIONS}\n\nREQUEST:\n${request}\n\nNOTES:\n${notes
          .map((note, index) => `[${index + 1}] ${note}`)
          .join("\n")}`,
        signal: AbortSignal.timeout(90_000),
      });
      return selectedNotes(
        notes,
        responseSchema.parse(response).selected.map((entry) => entry.note),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
