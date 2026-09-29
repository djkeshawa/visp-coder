import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntimeError, launchChrome } from "../../../src/testing/chrome-transport.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static instance: FakeSocket | undefined;
  readyState = 0;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.instance = this;
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.disconnect();
  }
  /** The browser side going away: Chrome killed or crashed. */
  disconnect() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

beforeEach(() => {
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    pid: undefined,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() =>
      child.stderr?.emit("data", Buffer.from("DevTools listening on ws://127.0.0.1:9222/x\n")),
    );
    return child;
  });
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.instance = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Chrome transport after the browser is gone", () => {
  it("rejects an in-flight send as soon as the socket closes", async () => {
    const transport = await launchChrome({ operationTimeoutMs: 5_000 });
    const inFlight = transport.send("Page.enable");
    const outcome = inFlight.catch((error: unknown) => error);
    FakeSocket.instance?.disconnect();
    await expect(outcome).resolves.toMatchObject({
      message: "browser disconnected",
      status: "failed",
    });
    await transport.close();
  });

  it("rejects later sends at once instead of waiting out the operation timeout", async () => {
    const transport = await launchChrome({ operationTimeoutMs: 5_000 });
    FakeSocket.instance?.disconnect();
    const started = performance.now();
    const failure = await transport.send("Page.enable").catch((error: unknown) => error);
    expect(performance.now() - started).toBeLessThan(500);
    expect(failure).toBeInstanceOf(BrowserRuntimeError);
    expect(failure).toMatchObject({ message: "browser disconnected", status: "failed" });
    expect(FakeSocket.instance?.sent).toEqual([]);
    await transport.close();
  });

  it("rejects a send made after close()", async () => {
    const transport = await launchChrome({ operationTimeoutMs: 5_000 });
    await transport.close();
    await expect(transport.send("Page.enable")).rejects.toMatchObject({
      message: "browser disconnected",
      status: "failed",
    });
  });

  it("still sends while the browser is connected", async () => {
    const transport = await launchChrome({ operationTimeoutMs: 5_000 });
    const reply = transport.send("Page.enable");
    const socket = FakeSocket.instance;
    const request = JSON.parse(socket?.sent[0] ?? "{}") as { id: number };
    socket?.dispatchEvent(
      Object.assign(new Event("message"), { data: JSON.stringify({ id: request.id, result: {} }) }),
    );
    await expect(reply).resolves.toEqual({});
    await transport.close();
  });
});
