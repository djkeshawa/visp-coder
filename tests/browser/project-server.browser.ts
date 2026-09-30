import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBrowserJourney } from "../../src/testing/browser-journey.js";
import * as projectServer from "../../src/testing/project-server.js";

let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-project-journey-"));
  outside = await mkdtemp(join(tmpdir(), "visp-project-outside-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

// An ES module that fetches a sibling JSON file: the shape that breaks under file: and works over HTTP.
const page = `<!doctype html><meta charset="utf-8"><title>Game</title><body>
<button id="go" type="button">Go</button><p id="out">Loading</p>
<script type="module" src="./game.js"></script>`;
const game = `import { title } from "./data.js";
const data = await (await fetch("./level.json")).json();
const out = document.querySelector("#out");
out.textContent = "Ready " + data.name + " " + title;
document.querySelector("#go").addEventListener("click", () => { out.textContent = "Played " + data.name; });`;

async function writeGame() {
  await writeFile(join(root, "index.html"), page);
  await writeFile(join(root, "game.js"), game);
  await writeFile(join(root, "data.js"), 'export const title = "tiny";');
  await writeFile(join(root, "level.json"), '{"name":"one"}');
}
const run = (url: string, actions: object[] = []) =>
  runBrowserJourney({
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: { url, actions: actions as never },
  });
const navigation = (result: Awaited<ReturnType<typeof run>>) =>
  result.operations.find((operation) => operation.kind === "navigate")?.description;
const refused = (port: string) =>
  fetch(`http://127.0.0.1:${port}/`).then(
    () => false,
    () => true,
  );

describe("project: journeys", () => {
  it("runs a module game that fetches a sibling file, from the current project bytes", async () => {
    await writeGame();
    const result = await run("project:/index.html", [
      {
        kind: "wait-for",
        selector: "#out",
        text: "Ready one tiny",
        timeoutMs: 5000,
        capture: false,
      },
      { kind: "click", selector: "#go", capture: false },
      { kind: "wait-for", selector: "#out", text: "Played one", timeoutMs: 5000, capture: true },
    ]);
    expect(result.status).toBe("completed");
    expect(result.captures.length).toBeGreaterThanOrEqual(2);
    const digest = createHash("sha256").update(page).digest("hex").slice(0, 12);
    expect(navigation(result)).toBe(
      `Navigate project:/index.html (HTTP 200), served by VISP from the project, sha256 ${digest}`,
    );
    // Only the capture route (display) names the ephemeral port; the navigation never does.
    expect(navigation(result)).not.toContain("127.0.0.1");
  });

  it("gives every run of the same project journey the same capture route, without the port", async () => {
    await writeGame();
    const actions = [
      {
        kind: "wait-for",
        selector: "#out",
        text: "Ready one tiny",
        timeoutMs: 5000,
        capture: false,
      },
      { kind: "click", selector: "#go", capture: true },
    ];
    const first = await run("project:/index.html", actions);
    const second = await run("project:/index.html", actions);
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    const routes = [...first.captures, ...second.captures].map((capture) => capture.route);
    expect(new Set(routes)).toEqual(new Set(["project:/index.html"]));
    for (const capture of [...first.captures, ...second.captures])
      expect(capture.steps.join(" ")).not.toContain("127.0.0.1");
  });

  it("changes the digest when the served document changes and serves a directory index", async () => {
    await writeGame();
    await mkdir(join(root, "levels"));
    await writeFile(join(root, "levels", "index.html"), "<!doctype html><p>level</p>");
    const first = await run("project:/levels/");
    const second = await run("project:/levels");
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(navigation(second)).toContain("redirected to project:/levels/");
    await writeFile(join(root, "levels", "index.html"), "<!doctype html><p>changed</p>");
    const third = await run("project:/levels/");
    expect(navigation(third)).not.toBe(navigation(first));
  });

  it("fails a missing project file as product behavior with the spec message and a failure image", async () => {
    await writeGame();
    const result = await run("project:/nope.html");
    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ kind: "behavior" });
    expect(result.failure?.message).toBe(
      "project:/nope.html does not exist in the project (HTTP 404); check the path relative to the project root.",
    );
    expect(result.captures).toHaveLength(1);
  });

  it("never serves secrets, VISP state, build output or files behind links", async () => {
    await writeGame();
    await writeFile(join(root, ".env"), "TOKEN=SECRET");
    await mkdir(join(root, ".visp"));
    await writeFile(join(root, ".visp", "state.json"), "SECRET");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "app.js"), "SECRET");
    await writeFile(join(outside, "secret.html"), "<p>OUTSIDE-SECRET</p>");
    await symlink(join(outside, "secret.html"), join(root, "linked.html"));
    await symlink(outside, join(root, "linked"));
    for (const path of [
      ".env",
      ".visp/state.json",
      "dist/app.js",
      "linked.html",
      "linked/secret.html",
    ]) {
      const result = await run(`project:/${path}`);
      expect(result.status).toBe("failed");
      expect(result.failure?.message).toContain("could not be served from the project (HTTP 403)");
      expect(JSON.stringify(result)).not.toContain("OUTSIDE-SECRET");
    }
  });

  it("notes a blocked sub-resource on the journey without serving it", async () => {
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><p>hi</p><script src="/dist/app.js"></script>',
    );
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "app.js"), "document.body.dataset.built='yes'");
    const result = await run("project:/index.html", [
      {
        kind: "wait-for",
        selector: "body",
        attribute: { name: "data-built", value: "yes" },
        timeoutMs: 300,
        capture: false,
      },
    ]);
    expect(result.status).toBe("timed-out");
    expect(
      result.operations.some((operation) =>
        operation.description.includes("refused 1 request(s): 403 GET /dist/app.js"),
      ),
    ).toBe(true);
  });

  it("stops the server after the journey, whether it completes or fails", async () => {
    await writeGame();
    const spy = vi.spyOn(projectServer, "startProjectServer");
    for (const url of ["project:/index.html", "project:/nope.html"]) {
      await run(url);
      const server = await spy.mock.results.at(-1)?.value;
      expect(await refused(new URL(server.origin).port)).toBe(true);
    }
    spy.mockRestore();
  });

  it("stops the server after an abort", async () => {
    await writeGame();
    const spy = vi.spyOn(projectServer, "startProjectServer");
    const controller = new AbortController();
    const pending = runBrowserJourney({
      projectRoot: root,
      directory: join(root, "captures"),
      subjectDigest: "a".repeat(64),
      signal: controller.signal,
      journey: {
        url: "project:/index.html",
        actions: [
          { kind: "wait-for", selector: "#never", text: "x", timeoutMs: 10000, capture: false },
        ],
      },
    });
    setTimeout(() => controller.abort(), 1500);
    const result = await pending;
    expect(["cancelled", "failed"]).toContain(result.status);
    const server = await spy.mock.results.at(-1)?.value;
    expect(await refused(new URL(server.origin).port)).toBe(true);
    spy.mockRestore();
  });
});
