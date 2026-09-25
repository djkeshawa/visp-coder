import { z } from "zod";
import { criticConfigSchema } from "./critic.js";

/** Read old spending records without exposing ignored controls to current configuration. */
export const historicalCriticConfigSchema = criticConfigSchema
  .extend({
    maxOutputTokens: z.number().int().positive().optional(),
    maxInputCharacters: z.number().int().positive().optional(),
  })
  .transform(({ maxOutputTokens: _tokens, maxInputCharacters: _characters, ...active }) => active);
