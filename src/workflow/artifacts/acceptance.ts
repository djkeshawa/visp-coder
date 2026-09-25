import { z } from "zod";
import { commandSpecSchema, pathPatternSchema, sha256Schema } from "./common.js";

const acceptancePath = pathPatternSchema.refine(
  (path) =>
    !/[\\*?[\]{}]/.test(path) &&
    !path.startsWith("./") &&
    !path.includes(":") &&
    !path.startsWith(".visp/") &&
    path !== ".visp",
  "Acceptance files must be exact project-relative POSIX paths outside .visp",
);

export const acceptanceCheckSchema = z
  .object({
    command: commandSpecSchema,
    files: z.array(acceptancePath).nonempty(),
  })
  .strict();

export const acceptanceBaselineSchema = z.array(
  z
    .object({
      command: commandSpecSchema,
      files: z.array(z.object({ path: acceptancePath, sha256: sha256Schema }).strict()).nonempty(),
    })
    .strict(),
);

export type AcceptanceBaseline = z.infer<typeof acceptanceBaselineSchema>;
