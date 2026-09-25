import { fromUnknown } from "../../core/errors.js";
import type { ProductCriticHost } from "./critic.js";
import type { CriticAdapterCall, CriticConfig } from "./critic-model.js";
import type { CriticPacket } from "./critic-packet.js";

/** Observe the attached adapter, not provider billing or model startup hidden inside it. */
export async function invokeCriticOnce(
  host: ProductCriticHost,
  packet: CriticPacket,
  config: CriticConfig,
  expiresAt: number,
  signal?: AbortSignal,
) {
  let response: Awaited<ReturnType<ProductCriticHost["review"]>> | undefined;
  let startedAt: number | undefined;
  let returnedAt: number | undefined;
  let failure: string | undefined;
  let outcome: CriticAdapterCall["outcome"] = "failed";
  const controller = new AbortController();
  const cancel = () => {
    outcome = "cancelled";
    controller.abort();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal?.aborted) {
      outcome = "cancelled";
      throw new Error("Critic invocation cancelled before adapter call");
    }
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      outcome = "timed-out";
      throw new Error("Critic deadline exceeded before adapter call");
    }
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () =>
          reject(
            new Error(
              outcome === "timed-out"
                ? "Critic deadline exceeded; no response returned before the deadline; late results are discarded"
                : "Critic invocation cancelled by caller",
            ),
          ),
        { once: true },
      );
      timer = setTimeout(() => {
        outcome = "timed-out";
        controller.abort();
      }, remainingMs);
    });
    response = await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted)
          throw new Error("Critic invocation cancelled before adapter call");
        startedAt = Date.now();
        return host.review(packet, { ...config, signal: controller.signal });
      }),
      interrupted,
    ]);
    // Capture completion before filesystem validation or lock acquisition.
    returnedAt = Date.now();
    outcome = "returned";
  } catch (cause) {
    failure = fromUnknown(cause).message;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (timer) clearTimeout(timer);
    controller.abort();
  }
  const adapterCall: CriticAdapterCall = { startedAt, finishedAt: Date.now(), outcome };
  return { response, failure, returnedAt, adapterCall };
}
