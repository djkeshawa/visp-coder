import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  createProductFeature,
  runProductDone,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../src/workflow/product/index.js";
import { TestWorkspace } from "../unit/support/workspace.js";

let workspace: TestWorkspace;
afterEach(async () => workspace?.destroy());

it("executes indirect browser helpers without printed receipts and keeps unassessed experience unresolved", async () => {
  const markup = `<button style="width:100px;height:44px" onclick="document.querySelector('#phase').textContent='saved'">Save</button><output id="phase">ready</output>`;
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(await readFile(resolve(workspace.root, "src/app.html"), "utf8"));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP port");
  const helper = `import {openBrowserSession} from ${JSON.stringify(pathToFileURL(resolve("dist/testing.js")).href)};
    import assert from 'node:assert/strict';
    export async function checkSave() {
      const browser=await openBrowserSession({directory:process.cwd(),subjectDigest:'a'.repeat(64),viewport:{width:390,height:844}});
      try {
        await browser.navigate('http://127.0.0.1:${address.port}/');
        await browser.page.mouse.click(50,20);
        assert.equal(await browser.page.evaluate(()=>document.querySelector('#phase').textContent,undefined),'saved');
      } finally {await browser.close();}
    }`;
  workspace = await TestWorkspace.create({
    "src/app.html": markup,
    "tests/helper.mjs": helper,
    "tests/browser.test.mjs":
      "import {test} from 'node:test';import {checkSave} from './helper.mjs';test('saving updates the rendered state',checkSave);",
  });
  try {
    await workspace.installFoundation();
    workspace.commit("install browser fixture");
    const started = await createProductFeature(await workspace.state(), {
      goal: "Save visibly updates the page",
    });
    if (!started.ok) throw new Error(started.error.message);
    const updated = await updateProductBrief(await workspace.state(), {
      brief: {
        ...started.value.brief,
        outcomes: [
          {
            id: "O001",
            kind: "experience",
            statement: "Save displays the saved state",
            priority: "must",
            reviewRequired: true,
          },
        ],
        checks: [
          {
            id: "C001",
            command: [process.execPath, "--test", "tests/browser.test.mjs"],
            outcomes: ["O001"],
            files: ["src/app.html", "tests/helper.mjs", "tests/browser.test.mjs"],
            environment: "browser",
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Make Save work",
            outcomes: ["O001"],
            scope: { allowed: ["src/**", "tests/**"] },
            checks: ["C001"],
          },
        ],
      },
    });
    if (!updated.ok) throw new Error(updated.error.message);
    expect((await runProductWork(await workspace.state())).ok).toBe(true);
    const verified = await runProductVerify(await workspace.state());
    expect(verified, JSON.stringify(verified)).toMatchObject({
      ok: true,
      value: {
        passed: false,
        outcomes: [
          expect.objectContaining({ id: "O001", behavior: "passed", review: "unassessed" }),
        ],
        executions: expect.arrayContaining([
          expect.objectContaining({ check: "C001", status: "passed" }),
        ]),
      },
    });
    // Actual browser execution is useful evidence; it does not replace inspection of the experience.
    expect(await runProductDone(await workspace.state())).toMatchObject({
      ok: true,
      value: { closed: false },
    });
    await workspace.write(
      "src/app.html",
      markup.replace("textContent='saved'", "textContent='incorrect'"),
    );
    const broken = await runProductVerify(await workspace.state());
    expect(broken).toMatchObject({
      ok: true,
      value: {
        passed: false,
        executions: expect.arrayContaining([
          expect.objectContaining({ check: "C001", status: "failed" }),
        ]),
      },
    });
    expect(JSON.stringify(broken)).toContain("incorrect");
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});
