import type { UiChange, UiEnvelope, UiError } from "../../src/ui/contract.js";

export type Loaded<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: UiError; readonly status: number };

export class SignedOutError extends Error {}

export async function signIn(token: string): Promise<boolean> {
  const response = await fetch("/api/v1/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    credentials: "same-origin",
  });
  return response.status === 204;
}

export async function load<T>(path: string): Promise<Loaded<T>> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  } catch {
    return {
      ok: false,
      status: 0,
      error: {
        code: "OFFLINE",
        message: "The dashboard server is not answering. It may have been stopped.",
        recovery: "visp ui",
      },
    };
  }
  if (response.status === 401) throw new SignedOutError();
  let body: UiEnvelope<T> | undefined;
  try {
    body = (await response.json()) as UiEnvelope<T>;
  } catch {
    body = undefined;
  }
  if (body?.ok && body.data !== undefined) return { ok: true, data: body.data };
  return {
    ok: false,
    status: response.status,
    error: body?.error ?? { code: "INTERNAL", message: `The server answered ${response.status}` },
  };
}

export type LiveState = "connecting" | "live" | "paused";

/** Change events name what to re-fetch; the page never trusts them for data. */
export function subscribe(
  onChange: (change: UiChange) => void,
  onState: (state: LiveState) => void,
): () => void {
  const source = new EventSource("/api/v1/events", { withCredentials: true });
  onState("connecting");
  source.addEventListener("hello", () => onState("live"));
  source.addEventListener("change", (event) => {
    try {
      onChange(JSON.parse((event as MessageEvent<string>).data) as UiChange);
    } catch {
      // A malformed event is ignored; the next one or the periodic refresh catches up.
    }
  });
  source.addEventListener("error", () =>
    onState(source.readyState === EventSource.CLOSED ? "paused" : "connecting"),
  );
  return () => source.close();
}
