import { z } from "zod";
import { sha256Schema } from "./common.js";

/** Authored design intent, not a generated aesthetic score or execution receipt. */
export const designBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    audience: z.string().min(1),
    primaryJourneys: z.array(z.string().min(1)).min(1),
    references: z.array(
      z
        .object({
          source: z.string().min(1),
          purpose: z.string().min(1),
          sha256: sha256Schema.optional(),
        })
        .strict(),
    ),
    visualDirection: z.string().min(1),
    typography: z.string().min(1),
    spacing: z.string().min(1),
    responsiveBehavior: z.string().min(1),
    states: z.array(z.string().min(1)).min(1),
    accessibility: z.array(z.string().min(1)).min(1),
    /** Meaningful to browser tasks; other rendered media may name sizes in states. */
    viewports: z
      .array(
        z
          .object({
            name: z.string().min(1),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type DesignBrief = z.infer<typeof designBriefSchema>;
