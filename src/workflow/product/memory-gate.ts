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
 * Told only to skip other endpoints' limits, it sometimes dropped a resource invariant (a
 * maximum quantity stated for item creation, needed by restock): 2 of 7 selections. Naming
 * resource invariants as always applying, it chose them in 5 of 5 with no trap selected.
 * On a spreadsheet engine it then never chose "digits must be a whole number from 0 to 10",
 * stated for ROUND, for new ROUNDUP and ROUNDDOWN (0 of 5): decisions about a kind of argument
 * or value also carry to new operations that take it, while another argument's limits do not.
 * With that, it chose it 5 of 5, and on both inventory stores still chose only the current
 * decisions with no trap.
 */
const INSTRUCTIONS = `A user sent the REQUEST below to an AI coding assistant. The NOTES are recorded from the user's earlier requests on the same project. Select only the notes that constrain how THIS request must be implemented, so the new behavior stays consistent with what the user already decided:
- Keep invariants of a resource that the requested operations could violate or must respect: a maximum or minimum on a stored value, a state in which an action is forbidden, a required field in every representation. They apply to every operation on that resource, even if the earlier request stated them for a different operation.
- Keep decisions about a kind of value or argument that the requested behavior also takes or produces (for example which values an argument of that kind accepts, or what a computation of that kind returns in an edge case), even if the earlier request stated them for one operation: new operations handling the same kind of value should behave the same way.
- Leave out notes about other features, and limits on a different kind of value or argument (for example a per-line or per-request limit of a different endpoint, or the allowed range of a differently named argument), even if they look similar. Leave out notes the request itself contradicts.
Return {"selected": []} when none apply. Do not read files or run commands.`;

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
