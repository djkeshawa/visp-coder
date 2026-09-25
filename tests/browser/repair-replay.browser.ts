import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runProductCapture } from "../../src/workflow/evidence/product-capture.js";
import { currentJourneyFailures } from "../../src/workflow/product/evidence-references.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { productSourceDigest } from "../../src/workflow/product/subject.js";
import { productWorkspace } from "../unit/support/product-workspace.js";

it("retains a failed second interaction across edits and replays its unchanged assertions", async () => {
  const { workspace } = await productWorkspace();
  const page = (
    fixed: boolean,
  ) => `<!doctype html><button id="act" style="margin:30px;padding:30px">Act</button><output id="result">0</output><script>
  let count=0; document.querySelector('#act').onclick=()=>{${fixed ? "" : "if(count>0)return;"} document.querySelector('#result').textContent=String(++count)};
  </script>`;
  try {
    await workspace.write("index.html", page(false));
    const state = await workspace.state();
    const url = pathToFileURL(join(workspace.root, "index.html")).href;
    const first = [
      { kind: "click", selector: "#act" },
      { kind: "wait-for", selector: "#result", text: "1", timeoutMs: 800 },
    ];
    const shallow = await runProductCapture(state, {
      task: "T001",
      journey: { url, actions: first },
    });
    expect(shallow.ok && shallow.value.status).toBe("completed");
    const failed = await runProductCapture(state, {
      task: "T001",
      journey: {
        url,
        actions: [
          ...first,
          { kind: "click", selector: "#act" },
          { kind: "wait-for", selector: "#result", text: "2", timeoutMs: 800 },
        ],
      },
    });
    if (!failed.ok) throw new Error(failed.error.message);
    expect(failed.value.status).toBe("timed-out");
    expect(failed.value.failure?.actionIndex).toBe(3);
    await workspace.write("index.html", page(true));
    const record = await readProductRecord(state);
    const subject = await productSourceDigest(state);
    if (!record.ok || !subject.ok) throw new Error("Missing current product");
    expect(currentJourneyFailures(record.value, subject.value).join(" ")).toContain(
      failed.value.runId,
    );
    // A new first-action-only capture cannot resolve the original second-action failure.
    await runProductCapture(state, { task: "T001", journey: { url, actions: first } });
    const unchanged = await readProductRecord(state);
    if (!unchanged.ok) throw new Error(unchanged.error.message);
    expect(currentJourneyFailures(unchanged.value, subject.value).join(" ")).toContain(
      failed.value.runId,
    );
    const replay = await runProductCapture(state, { replay: failed.value.runId });
    expect(replay.ok && replay.value.status).toBe("completed");
    const repaired = await readProductRecord(state);
    if (!repaired.ok) throw new Error(repaired.error.message);
    expect(currentJourneyFailures(repaired.value, subject.value)).toEqual([]);
    expect(repaired.value.state.captureRuns).toHaveLength(4);
  } finally {
    await workspace.destroy();
  }
});

it("observes reset while work is pending beyond the old callback deadline in the same session", async () => {
  const { workspace } = await productWorkspace();
  const page = (
    fixed: boolean,
  ) => `<!doctype html><button id="start">Start</button><button id="reset">Reset</button><output id="result">ready</output><script>
  let generation=0; const result=document.querySelector('#result');
  document.querySelector('#start').onclick=()=>{const own=generation;result.textContent='pending';setTimeout(()=>{${fixed ? "if(own!==generation)return;" : ""}result.textContent='done'},1500)};
  document.querySelector('#reset').onclick=()=>{generation++;result.textContent='ready'};
  </script>`;
  try {
    for (const fixed of [false, true]) {
      await workspace.write("reset.html", page(fixed));
      const result = await runProductCapture(await workspace.state(), {
        journey: {
          url: pathToFileURL(join(workspace.root, "reset.html")).href,
          actions: [
            { kind: "click", selector: "#start" },
            { kind: "wait-for", selector: "#result", text: "pending" },
            { kind: "click", selector: "#reset" },
            { kind: "wait", durationMs: 1700 },
            { kind: "wait-for", selector: "#result", text: "ready", timeoutMs: 500 },
            { kind: "click", selector: "#start" },
            { kind: "wait-for", selector: "#result", text: "done", timeoutMs: 2500 },
          ],
        },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) expect(result.value.status).toBe(fixed ? "completed" : "timed-out");
    }
  } finally {
    await workspace.destroy();
  }
});
