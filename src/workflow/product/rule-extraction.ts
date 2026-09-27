import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { reachesModel, runCodexStructured } from "./critic-exec.js";
import type { RuleExtractor } from "./project-rules.js";

/**
 * Users state lasting rules in many ways: "house style", "whenever you touch X", "for the
 * rest of this project", or plain prose. Phrase matching found 4 of 18 such prompts in a
 * held-out set; this prompt, at low effort on the reviewer's model, found all 18 and no
 * rule in 12 ordinary requests, at about nine seconds a prompt.
 */
const INSTRUCTIONS = `You read one message a user sent to an AI coding assistant working in their repository. List the STANDING RULES the message states: requirements the user says also apply beyond this request, to later requests, future sessions or the whole project (conventions, house style, "from now on", "always when you touch X", "for the rest of this project"). Do NOT list requirements that only concern the current task, acceptance criteria for this change, or plans that might happen later.
For each standing rule return "rule": the rule as one self-contained sentence that keeps every exact name, number, status code and example, and "quote": a verbatim excerpt of the message (copied exactly, at least a few words) that states it. Return {"rules": []} when there are none. Do not read files or run commands.

Message:
`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rules"],
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule", "quote"],
        properties: { rule: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
} as const;
const responseSchema = z.object({
  rules: z.array(z.object({ rule: z.string(), quote: z.string() })),
});

/** The model sees only the prompt, in an empty directory, never the repository. */
export function codexRuleExtractor(options: {
  model: string;
  executable?: string;
  lookup?: (host: string) => Promise<unknown>;
}): RuleExtractor {
  return async (prompt) => {
    const { lookup: dnsLookup } = await import("node:dns/promises");
    if (!(await reachesModel(options.lookup ?? ((host) => dnsLookup(host)))))
      throw new Error("The rule reader cannot reach its model from this process");
    const directory = await mkdtemp(join(tmpdir(), "visp-rules-"));
    try {
      const response = await runCodexStructured({
        ...(options.executable ? { executable: options.executable } : {}),
        root: directory,
        directory,
        model: options.model,
        reasoningEffort: "low",
        schema: RESPONSE_SCHEMA,
        prompt: `${INSTRUCTIONS}${prompt}`,
        signal: AbortSignal.timeout(90_000),
      });
      return responseSchema.parse(response).rules;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
