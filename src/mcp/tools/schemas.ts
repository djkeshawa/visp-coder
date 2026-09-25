import { z } from "zod";

/** Live MCP input shapes. Retired tool schemas are defined by their compatibility handlers. */
export const guardInput = {
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Repository-relative paths to check before writing them"),
} as const;
