import type { ProductCheck } from "./model.js";

/** Declared check images are outputs, not product source: rewriting one does not change the product. */
export function declaredCheckImages(checks: readonly ProductCheck[] | undefined): Set<string> {
  return new Set(
    (checks ?? []).flatMap((check) =>
      (check.images ?? []).map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "")),
    ),
  );
}
