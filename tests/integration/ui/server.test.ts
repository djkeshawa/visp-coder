import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli/program.js";
import type {
  UiEnvelope,
  UiExecution,
  UiFeature,
  UiOverview,
  UiRequests,
} from "../../../src/ui/contract.js";
import { cookieName } from "../../../src/ui/security.js";
import { startUiServer, type UiServer } from "../../../src/ui/server.js";
import { runProductUserFeedback } from "../../../src/workflow/product/user-feedback.js";
import { uiScenario } from "../../unit/support/ui-scenario.js";
import type { TestWorkspace } from "../../unit/support/workspace.js";

let workspace: TestWorkspace;
let accepted: string;
let active: string;
let server: UiServer;
let assets: string;
let cookie: string;

beforeAll(async () => {
  ({ workspace, accepted, active } = await uiScenario());
  assets = await mkdtemp(join(tmpdir(), "visp-ui-assets-"));
  await writeFile(join(assets, "index.html"), "<!doctype html><title>visp</title>");
  server = await startUiServer({ root: workspace.root, assetsDir: assets });
  cookie = `${cookieName(server.port)}=${server.token}`;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await workspace?.destroy();
  await rm(assets, { recursive: true, force: true });
});

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** Raw HTTP, so tests can send the Host and Origin headers a browser would. */
function send(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: options.method ?? "GET",
        headers: { host: `127.0.0.1:${server.port}`, ...options.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    outgoing.on("error", reject);
    if (options.body) outgoing.write(options.body);
    outgoing.end();
  });
}

async function api<T>(path: string): Promise<T> {
  const answer = await send(path, { headers: { cookie } });
  const envelope = JSON.parse(answer.body) as UiEnvelope<T>;
  if (!envelope.ok || envelope.data === undefined)
    throw new Error(`${path}: ${answer.status} ${answer.body}`);
  return envelope.data;
}

describe("access", () => {
  it("refuses API calls without the session cookie", async () => {
    const answer = await send("/api/v1/overview");
    expect(answer.status).toBe(401);
    expect(answer.body).not.toContain(accepted);
  });

  it("refuses requests addressed to another host name", async () => {
    const answer = await send("/api/v1/overview", {
      headers: { host: `attacker.example:${server.port}`, cookie },
    });
    expect(answer.status).toBe(421);
  });

  it("signs in only with the right token from the dashboard's own origin", async () => {
    const origin = `http://127.0.0.1:${server.port}`;
    const post = (headers: Record<string, string>, token: string) =>
      send("/api/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ token }),
      });
    expect((await post({}, server.token)).status).toBe(403);
    expect((await post({ origin: "http://evil.example" }, server.token)).status).toBe(403);
    expect((await post({ origin }, "wrong")).status).toBe(403);
    const signedIn = await post({ origin }, server.token);
    expect(signedIn.status).toBe(204);
    const setCookie = String(signedIn.headers["set-cookie"]);
    expect(setCookie).toContain(`${cookieName(server.port)}=${server.token}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("serves the page with a strict content security policy and no writes elsewhere", async () => {
    const page = await send("/");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect((await send("/api/v1/overview", { method: "DELETE", headers: { cookie } })).status).toBe(
      405,
    );
  });

  it("refuses capture paths that leave the feature's captures", async () => {
    const answer = await send(`/captures/${active}/..%2F..%2Fbrief.yaml`, { headers: { cookie } });
    expect(answer.status).toBe(400);
  });
});

describe("resources", () => {
  it("lists every feature with what it needs", async () => {
    const overview = await api<UiOverview>("/api/v1/overview");
    const byId = new Map(overview.features.map((feature) => [feature.id, feature]));
    expect(byId.get(accepted)).toMatchObject({ lifecycle: "accepted", goal: "Sum report amounts" });
    expect(byId.get(active)).toMatchObject({
      lifecycle: "active",
      active: true,
      slices: { total: 2, closed: 1, inProgress: 1 },
      pendingQuestions: 1,
    });
    expect(byId.get(active)?.openFindings).toBeGreaterThanOrEqual(2);
  });

  it("describes a feature from the workflow's own records", async () => {
    const feature = await api<UiFeature>(`/api/v1/features/${active}`);
    expect(feature.originalRequest).toContain("download the monthly report as a CSV file");
    expect(feature.next).toMatchObject({ action: "fix", task: "T002" });
    expect(feature.slices.map((slice) => [slice.id, slice.status])).toEqual([
      ["T001", "closed"],
      ["T002", "in-progress"],
    ]);
    const escaping = feature.slices[1]?.checks[0];
    expect(escaping).toMatchObject({ id: "C002", command: "node --test test/csv.test.mjs" });
    expect(escaping?.latest).toMatchObject({ status: "failed" });
    expect(escaping?.latest?.headline).toContain("cells with commas are quoted");
    expect(feature.findings.some((finding) => finding.problem.includes("cell('a,b')"))).toBe(true);
    expect(feature.questions[0]).toMatchObject({ status: "pending" });
    const times = feature.activity.map((entry) => entry.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(feature.report).toContain("Export reports as CSV");
  });

  it("returns a run's full output, and says when a run doesn't exist", async () => {
    const feature = await api<UiFeature>(`/api/v1/features/${active}`);
    const failed = feature.executions.find((run) => run.status === "failed");
    if (!failed) throw new Error("scenario has no failed run");
    const run = await api<UiExecution>(`/api/v1/features/${active}/executions/${failed.id}`);
    expect(run.output).toContain("AssertionError");
    expect(run.truncated).toBe(false);
    const missing = await send(`/api/v1/features/${active}/executions/nope`, {
      headers: { cookie },
    });
    expect(missing.status).toBe(404);
  });

  it("rejects a malformed feature id before touching the filesystem", async () => {
    const answer = await send("/api/v1/features/..%2F..%2Fetc", { headers: { cookie } });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(600);
    expect(answer.body).not.toContain("root:");
  });
});

describe("requests", () => {
  it("lists the pending question with a reply command the CLI actually accepts", async () => {
    const { requests } = await api<UiRequests>("/api/v1/requests");
    const question = requests.find((request) => request.kind === "question");
    expect(question?.feature).toBe(active);
    const words = question?.replyCommand?.split(" ") ?? [];
    expect(words.slice(0, 3)).toEqual(["visp", "critic", "feedback"]);
    const feedback = findCommand(buildProgram(), words.slice(1, 3));
    const flags = feedback?.options.map((option) => option.long) ?? [];
    for (const word of words.filter((entry) => entry.startsWith("--")))
      expect(flags).toContain(word);
  });
});

function findCommand(program: Command, path: readonly string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const name of path) current = current?.commands.find((command) => command.name() === name);
  return current;
}

describe("live updates", () => {
  it("announces a change to the feature when the workflow writes its state", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${server.port}/api/v1/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body?.getReader();
    const decoder = new TextDecoder();
    const reading = (async () => {
      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
      }
    })().catch(() => undefined);
    try {
      await expect.poll(() => events.join("").includes("event: hello")).toBe(true);
      const feature = await api<UiFeature>(`/api/v1/features/${active}`);
      const pending = feature.questions.find((entry) => entry.status === "pending");
      if (!pending) throw new Error("scenario has no pending question");
      const answered = await runProductUserFeedback(await workspace.state(), {
        feature: active,
        operation: "defer",
        id: pending.id,
      });
      expect(answered.ok).toBe(true);
      await expect
        .poll(() => events.join(""), { timeout: 5_000 })
        .toMatch(new RegExp(`event: change\\ndata: .*${active}`));
      const { requests } = await api<UiRequests>("/api/v1/requests");
      expect(requests.some((request) => request.kind === "question")).toBe(false);
    } finally {
      controller.abort();
      await reading;
    }
  });
});
