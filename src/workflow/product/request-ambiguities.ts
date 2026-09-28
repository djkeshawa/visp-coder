import { z } from "zod";

const text = z.string().trim().min(1);

/** Tester interpretations are advice, not new requirements or frozen assertions. */
export const requestAmbiguitySchema = z
  .object({
    quote: text,
    readings: z.array(text).min(2),
    conventionalReading: text,
  })
  .strict();

export type RequestAmbiguity = z.infer<typeof requestAmbiguitySchema>;
