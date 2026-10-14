import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import { checkImageCaptures } from "../../../../src/workflow/product/assessment.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import {
  runProductAccept,
  runProductDone,
  runProductReview,
  runProductVerify,
} from "../../../../src/workflow/product/index.js";
import {
  inheritedChangesContent,
  inheritedChangesPath,
} from "../../../../src/workflow/product/inherited-record.js";
import { type ProductBrief, productCheckSchema } from "../../../../src/workflow/product/model.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.destroy();
});

/** A valid one-pixel PNG of the given colour. */
function png(red: number, green: number, blue: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const SCENE = {
  id: "O002",
  kind: "experience" as const,
  statement: "The rendered scene shows each object the request names, recognizably",
  priority: "must" as const,
  provenance: "user-stated" as const,
  reviewRequired: true,
  expectations: [],
};

/** The check writes whichever image the script names; a different image on every run. */
async function imageCheck(script: string, images: string[]) {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  const next: ProductBrief = {
    ...brief,
    outcomes: [...brief.outcomes, SCENE],
    checks: brief.checks.map((check) => ({
      ...check,
      command: [process.execPath, "-e", script],
      outcomes: [...check.outcomes, SCENE.id],
      images,
    })),
  };
  const changed = await updateProductBrief(await workspace.state(), {
    brief: next,
    reason: "Render the scene for review",
  });
  if (!changed.ok) throw new Error(changed.error.message);
  const work = await runProductWork(await workspace.state());
  if (!work.ok) throw new Error(work.error.message);
  return workspace;
}

const RED = png(255, 0, 0).toString("base64");
const BLUE = png(0, 0, 255).toString("base64");
const writeRandomImage = `require("fs").mkdirSync("out",{recursive:true});require("fs").writeFileSync("out/scene.png",Buffer.from(Math.random()<0.5?${JSON.stringify(RED)}:${JSON.stringify(BLUE)},"base64"))`;

describe("images declared by a command check", () => {
  it("become review images of the product version the check ran against", async () => {
    const workspace = await imageCheck(writeRandomImage, ["out/scene.png"]);
    const verified = await runProductVerify(await workspace.state());
    expect(verified).toMatchObject({ ok: true, value: { passed: true } });
    const record = await readProductRecord(await workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    const execution = record.value.state.executions.at(-1);
    expect(execution?.checkImages).toHaveLength(1);
    const capture = record.value.state.captures.find(
      (entry) => (entry as { id: string }).id === execution?.checkImages?.[0],
    ) as { id: string; path: string; sha256: string; subjectDigest: string; route: string };
    expect(capture).toMatchObject({
      subjectDigest: execution?.subjectDigest,
      route: "check C001: out/scene.png",
      viewport: { width: 1, height: 1 },
      provenance: "runner-captured",
    });
    const copied = await readFile(join(workspace.root, capture.path));
    expect(sha256(copied)).toBe(capture.sha256);
    expect(copied).toEqual(await readFile(join(workspace.root, "out/scene.png")));

    const bundle = await runProductReview(await workspace.state(), {});
    if (!bundle.ok) throw new Error(bundle.error.message);
    expect(bundle.value.subjectDigest).toBe(execution?.subjectDigest);
    expect(bundle.value.images.map((image) => image.id)).toContain(capture.id);
  });

  it("do not change the product version when a rerun writes a different image", async () => {
    const workspace = await imageCheck(writeRandomImage, ["out/scene.png"]);
    const subjects = new Set<string>();
    for (let run = 0; run < 4; run += 1) {
      const verified = await runProductVerify(await workspace.state());
      if (!verified.ok) throw new Error(verified.error.message);
      for (const execution of verified.value.executions) subjects.add(execution.subjectDigest);
    }
    expect(subjects.size).toBe(1);
  });

  it("fail the check when the declared image was not written", async () => {
    const workspace = await imageCheck("process.exit(0)", ["out/scene.png"]);
    const verified = await runProductVerify(await workspace.state());
    expect(verified).toMatchObject({
      ok: true,
      value: {
        passed: false,
        executions: [
          {
            status: "failed",
            output: expect.stringContaining(
              "C001 passed but did not write its declared image out/scene.png in this run",
            ),
          },
        ],
      },
    });
  });

  it("fail the check when the declared image is left over from an earlier run", async () => {
    const workspace = await imageCheck("process.exit(0)", ["out/scene.png"]);
    await workspace.write("out/scene.png", png(255, 0, 0));
    const verified = await runProductVerify(await workspace.state());
    expect(verified).toMatchObject({
      ok: true,
      value: {
        passed: false,
        executions: [
          {
            status: "failed",
            output: expect.stringContaining(
              "C001 passed but did not write its declared image out/scene.png in this run; make the check write it",
            ),
          },
        ],
      },
    });
  });

  it("pass when the check rewrites the same image bytes", async () => {
    const red = JSON.stringify(RED);
    const workspace = await imageCheck(
      `require("fs").mkdirSync("out",{recursive:true});require("fs").writeFileSync("out/scene.png",Buffer.from(${red},"base64"))`,
      ["out/scene.png"],
    );
    await workspace.write("out/scene.png", png(255, 0, 0));
    const verified = await runProductVerify(await workspace.state());
    expect(verified).toMatchObject({ ok: true, value: { passed: true } });
  });

  it("stay product when they existed before the feature started", async () => {
    const workspace = await imageCheck(writeRandomImage, ["out/scene.png"]);
    await workspace.write("out/scene.png", png(255, 0, 0));
    const state = await workspace.state();
    const record = await readProductRecord(state);
    if (!record.ok) throw new Error(record.error.message);
    const written = await productSourceSnapshot(state, record.value.brief);
    expect(written).toMatchObject({ ok: true });
    if (written.ok) expect(written.value).not.toHaveProperty(["out/scene.png"]);
    // Uncommitted work the feature started from, as recorded when Git could not be written.
    await workspace.write(
      relative(workspace.root, inheritedChangesPath(state, record.value.brief.feature)),
      inheritedChangesContent({ "out/scene.png": "earlier" }),
    );
    const inherited = await productSourceSnapshot(await workspace.state(), record.value.brief);
    expect(inherited).toMatchObject({ ok: true });
    if (inherited.ok) expect(inherited.value).toHaveProperty(["out/scene.png"]);
  });

  it("fail the check when the declared file is not an image", async () => {
    const workspace = await imageCheck(
      'require("fs").mkdirSync("out",{recursive:true});require("fs").writeFileSync("out/scene.png","<svg/>")',
      ["out/scene.png"],
    );
    const verified = await runProductVerify(await workspace.state());
    expect(verified).toMatchObject({
      ok: true,
      value: {
        passed: false,
        executions: [{ status: "failed", output: expect.stringContaining("is not a PNG") }],
      },
    });
  });

  it("must cover an experience outcome, so how the picture looks can fail", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const technicalOnly = await updateProductBrief(await workspace.state(), {
      brief: {
        ...brief,
        checks: brief.checks.map((check) => ({ ...check, images: ["out/scene.png"] })),
      },
      reason: "Declare the render without saying how it must look",
    });
    expect(technicalOnly).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(
          "C001 declares images, so it must cover an experience outcome",
        ),
      },
    });
    const covered = await updateProductBrief(await workspace.state(), {
      brief: {
        ...brief,
        outcomes: [...brief.outcomes, SCENE],
        checks: brief.checks.map((check) => ({
          ...check,
          outcomes: [...check.outcomes, SCENE.id],
          images: ["out/scene.png"],
        })),
      },
      reason: "Declare the render and how it must look",
    });
    expect(covered.ok).toBe(true);
  });

  it("satisfy a must experience outcome with the check's image, without a browser journey", async () => {
    const workspace = await imageCheck(writeRandomImage, ["out/scene.png"]);
    const done = await runProductDone(await workspace.state());
    expect(done).toMatchObject({ ok: true, value: { closed: true } });
    const bundle = await runProductReview(await workspace.state(), {});
    if (!bundle.ok) throw new Error(bundle.error.message);
    const image = bundle.value.images.find((entry) => entry.route === "check C001: out/scene.png");
    if (!image) throw new Error("the check image was not delivered");
    const feedback = moduleFeedback(bundle.value);
    const reviewed = await runProductReview(await workspace.state(), {
      subjectDigest: bundle.value.subjectDigest,
      feedback: {
        ...feedback,
        dimensions: feedback.dimensions.map((entry) =>
          entry.dimension === "experience"
            ? {
                ...entry,
                status: "satisfied" as const,
                reason: "The rendered scene shows the requested objects",
                evidence: [image.id, "C001"],
              }
            : entry,
        ),
      },
      assessments: [
        { outcome: "O001", status: "satisfied", summary: "The test passed", evidence: ["C001"] },
        {
          outcome: "O002",
          status: "satisfied",
          summary: "Each named object is recognizable in the rendered scene",
          evidence: [image.id, "C001"],
        },
      ],
    });
    if (!reviewed.ok) throw new Error(reviewed.error.message);
    expect(reviewed.value.assessments.find((entry) => entry.outcome === "O002")).toMatchObject({
      status: "satisfied",
    });
    const accepted = await runProductAccept(await workspace.state());
    expect(accepted).toMatchObject({ ok: true, value: { passed: true } });

    // A browser journey covering the outcome still has to be observed.
    const record = await readProductRecord(await workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    const subject = bundle.value.subjectDigest;
    expect(checkImageCaptures(record.value, subject, "O002")).toContain(image.id);
    const journey = {
      id: "C002",
      command: {
        kind: "browser-journey" as const,
        journey: { url: "http://localhost/", actions: [] },
      },
      outcomes: ["O002"],
      files: [],
      environment: "browser" as const,
    };
    const withJourney = {
      ...record.value,
      brief: { ...record.value.brief, checks: [...record.value.brief.checks, journey] },
    };
    expect(checkImageCaptures(withJourney, subject, "O002").size).toBe(0);
  });

  it("accept only image files inside the project", () => {
    const check = { id: "C001", command: ["node", "render.mjs"] };
    expect(productCheckSchema.safeParse({ ...check, images: ["out/a.png"] }).success).toBe(true);
    for (const path of [
      "../a.png",
      "/tmp/a.png",
      "C:\\a.png",
      "out/a.svg",
      "out/../../a.png",
      ".visp/a.png",
      "./.visp/features/a.png",
      ".VISP/a.png",
    ])
      expect(productCheckSchema.safeParse({ ...check, images: [path] }).success).toBe(false);
    expect(productCheckSchema.safeParse({ ...check, images: [] }).success).toBe(false);
  });
});
