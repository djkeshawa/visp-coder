import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runBrowserJourney } from "../../src/testing/browser-journey.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-local-drag-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const html = `<!doctype html><style>#pad {width:300px;height:200px;background:orange;touch-action:none} body{margin:0}</style><div id="pad">Ready</div><script src="app.js"></script>`;
const script = `const pad=document.querySelector('#pad');let down=false;pad.addEventListener('pointerdown',e=>{if(e.isTrusted){down=true;pad.setPointerCapture(e.pointerId);pad.textContent='Dragging';pad.style.background='lightblue'}});pad.addEventListener('pointermove',e=>{if(down&&e.isTrusted)pad.dataset.x=String(e.clientX)});pad.addEventListener('pointerup',e=>{if(down&&e.isTrusted){down=false;pad.textContent='Released';pad.style.background='limegreen';pad.dataset.input=e.pointerType}});`;
it.each(["pointer", "touch"] as const)(
  "captures real %s drag before, during and after release from confined files",
  async (input) => {
    await writeFile(join(root, "index.html"), html);
    await writeFile(join(root, "app.js"), script);
    const result = await runBrowserJourney({
      projectRoot: root,
      directory: join(root, "captures"),
      subjectDigest: "a".repeat(64),
      journey: {
        url: pathToFileURL(join(root, "index.html")).href,
        actions: [
          {
            kind: "drag",
            selector: "#pad",
            from: { x: 50, y: 50 },
            to: { x: 250, y: 50 },
            input,
            steps: 4,
            durationMs: 100,
            captureDuring: true,
            capture: true,
          },
          {
            kind: "wait-for",
            selector: "#pad",
            text: "Released",
            attribute: { name: "data-input", value: input === "pointer" ? "mouse" : "touch" },
            timeoutMs: 500,
            capture: false,
          },
        ],
      },
    });
    expect(result.captures).toHaveLength(4);
    expect(new Set(result.captures.slice(0, 3).map((entry) => entry.sha256)).size).toBe(3);
    expect(result.captures[1]?.steps.some((step) => step.startsWith("Begin"))).toBe(true);
    expect(result.captures[1]?.steps.some((step) => step.startsWith("Finish"))).toBe(false);
    expect(result.operations.filter((entry) => entry.kind === input)).toHaveLength(
      input === "pointer" ? 3 : 2,
    );
    expect(
      result.operations.some((entry) => entry.measurement?.json.includes('"text":"Released"')),
    ).toBe(true);
  },
);
it.each(["image", "iframe", "script"])(
  "rejects an outside-project %s request without publishing a journey",
  async (kind) => {
    const outside = await mkdtemp(join(tmpdir(), "visp-outside-"));
    try {
      await writeFile(join(outside, "private.txt"), "private bytes");
      const url = pathToFileURL(join(outside, "private.txt")).href;
      await writeFile(
        join(root, "index.html"),
        `<html><${kind === "image" ? "img" : kind} src="${url}"></${kind}></html>`,
      );
      await expect(
        runBrowserJourney({
          projectRoot: root,
          directory: join(root, "captures"),
          subjectDigest: "a".repeat(64),
          journey: { url: pathToFileURL(join(root, "index.html")).href, actions: [] },
        }),
      ).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  },
);
it("rejects symlinked resources and project-blocked subresources", async () => {
  await writeFile(join(root, "private.js"), "document.body.textContent='should not execute'");
  await symlink(join(root, "private.js"), join(root, "app.js"));
  await writeFile(join(root, "index.html"), html);
  const options = {
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: { url: pathToFileURL(join(root, "index.html")).href, actions: [] },
  };
  await expect(runBrowserJourney(options)).rejects.toThrow();
  await rm(join(root, "app.js"));
  await writeFile(join(root, "app.js"), script);
  await expect(runBrowserJourney({ ...options, blockedPaths: ["app.js"] })).rejects.toThrow(
    /allowed project content/,
  );
});
it("does not accept an incorrect intermediate transition because the control exists", async () => {
  await writeFile(join(root, "index.html"), html);
  await writeFile(join(root, "app.js"), script);
  const result = await runBrowserJourney({
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: {
      url: pathToFileURL(join(root, "index.html")).href,
      actions: [
        { kind: "wait-for", selector: "#pad", text: "Released", timeoutMs: 100, capture: false },
      ],
    },
  });
  expect(result).toMatchObject({
    status: "timed-out",
    failure: { kind: "behavior", message: expect.stringContaining("expected browser state") },
  });
});

it.each(["popup", "worker"])(
  "reports unsupported local-file %s targets without a passing capture",
  async (kind) => {
    await writeFile(
      join(root, "index.html"),
      `<html><button onclick="${kind === "popup" ? "window.open('about:blank')" : "new Worker(window.URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'})))"}">Open</button></html>`,
    );
    await expect(
      runBrowserJourney({
        projectRoot: root,
        directory: join(root, "captures"),
        subjectDigest: "a".repeat(64),
        journey: {
          url: pathToFileURL(join(root, "index.html")).href,
          actions: [{ kind: "click", selector: "button", capture: true }],
        },
      }),
    ).rejects.toThrow(/extra browsing targets|security policy/);
  },
);
