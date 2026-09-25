import { z } from "zod";
import type { BrowserJourney } from "./browser-journey.js";

export const browserInputIdentitySchema = z
  .object({
    kind: z.enum(["click", "tap", "drag", "move", "key"]),
    selector: z.string().optional(),
    key: z.string().optional(),
    input: z.string().optional(),
  })
  .strict();

/** Stable input semantics, independent of layout coordinates and capture bookkeeping. */
export function browserInputIdentity(action: BrowserJourney["actions"][number] | undefined) {
  if (!action || !["click", "tap", "drag", "move", "key"].includes(action.kind)) return undefined;
  return browserInputIdentitySchema.parse({
    kind: action.kind,
    ...("selector" in action ? { selector: action.selector } : {}),
    ...("key" in action ? { key: action.key } : {}),
    ...(action.kind === "drag" ? { input: action.input ?? "pointer" } : {}),
  });
}
