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
import { pngHeader, type TestWorkspace } from "../../support/workspace.js";

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
async function imageCheck(script: string, images: string[], scope: string[] = []) {
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
    slices: brief.slices.map((slice) => ({
      ...slice,
      scope: { ...slice.scope, allowed: [...slice.scope.allowed, ...scope] },
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

  it("are not read when the check itself fails", async () => {
    const workspace = await imageCheck(`${writeRandomImage};process.exit(3)`, ["out/scene.png"]);
    const verified = await runProductVerify(await workspace.state());
    expect(verified).toMatchObject({
      ok: true,
      value: { passed: false, executions: [{ status: "failed", exitCode: 3 }] },
    });
    if (!verified.ok) return;
    expect(verified.value.executions[0]?.output).not.toContain("declared image");
    expect(verified.value.executions[0]?.checkImages).toBeUndefined();
    const record = await readProductRecord(await workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.captures).toEqual([]);
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

  it.each([
    [
      "is not an image",
      'fs.writeFileSync("out/scene.png","<svg/>")',
      "C001's declared image out/scene.png is not a PNG, JPEG, WebP or GIF file; make the check write one of those formats",
    ],
    [
      "is a symbolic link",
      `fs.writeFileSync("real.png",Buffer.from(${JSON.stringify(png(1, 2, 3).toString("base64"))},"base64"));fs.symlinkSync("../real.png","out/scene.png")`,
      "C001's declared image out/scene.png is a symbolic link or not a regular file; make the check write the image file itself",
    ],
    [
      "is larger than 4 MiB",
      `fs.writeFileSync("out/scene.png",Buffer.concat([Buffer.from(${JSON.stringify(pngHeader(10, 10).toString("base64"))},"base64"),Buffer.alloc(5*1024*1024)]))`,
      "C001's declared image out/scene.png is larger than 4 MiB; make the check write a smaller image",
    ],
    [
      "has more pixels than a reviewer accepts",
      `fs.writeFileSync("out/scene.png",Buffer.from(${JSON.stringify(pngHeader(9000, 10).toString("base64"))},"base64"))`,
      "C001's declared image out/scene.png is 9000×10 pixels; make the check write one at most 8000 pixels on each side",
    ],
  ])(
    "fail the check, naming it and what to do, when the declared file %s",
    async (_case, write, note) => {
      const workspace = await imageCheck(
        `const fs=require("fs");fs.mkdirSync("out",{recursive:true});${write}`,
        ["out/scene.png"],
      );
      const verified = await runProductVerify(await workspace.state());
      expect(verified).toMatchObject({
        ok: true,
        value: {
          passed: false,
          executions: [{ status: "failed", output: expect.stringContaining(note) }],
        },
      });
    },
  );

  it("are refused on a browser journey, whose captures already reach the reviewer", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const journey = await updateProductBrief(await workspace.state(), {
      brief: {
        ...brief,
        outcomes: [...brief.outcomes, SCENE],
        checks: [
          ...brief.checks,
          {
            id: "C002",
            command: {
              kind: "browser-journey" as const,
              journey: { url: "project:/index.html", actions: [] },
            },
            outcomes: [SCENE.id],
            files: [],
            environment: "browser" as const,
            images: ["out/scene.png"],
          },
        ],
      },
      reason: "Declare an image on a journey",
    });
    expect(journey).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining(
          "C002 is a browser journey, whose captures already reach the reviewer; remove its images, which only a command check writes",
        ),
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
          "C001 declares images, so it must cover an experience outcome: add an outcome with kind: experience naming what the picture must show (each object, subject and look the request names, recognizable), and list its ID in the outcomes of C001 and of slice T001",
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
    await reviewWithCheckImage(workspace, "satisfied");
    const accepted = await runProductAccept(await workspace.state());
    expect(accepted).toMatchObject({ ok: true, value: { passed: true } });
  });

  // A canvas web game observes play through captured journeys; one still frame is not play.
  it("do not stand in for a journey when the slice owning the outcome has a web UI", async () => {
    const workspace = await imageCheck(writeRandomImage, ["out/scene.png"], ["index.html"]);
    await workspace.write("index.html", "<canvas></canvas>\n");
    const assessment = await reviewWithCheckImage(workspace, "unavailable");
    expect(assessment?.summary).toContain("interaction journey");
    const accepted = await runProductAccept(await workspace.state());
    expect(accepted).toMatchObject({ ok: true, value: { passed: false } });
  });

  async function reviewWithCheckImage(workspace: TestWorkspace, expected: string) {
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
    const assessment = reviewed.value.assessments.find((entry) => entry.outcome === "O002");
    expect(assessment).toMatchObject({ status: expected });
    return assessment;
  }

  it("name the images that stand in for a journey only without a browser journey", async () => {
    const workspace = await imageCheck(writeRandomImage, ["out/scene.png"]);
    await runProductDone(await workspace.state());
    const bundle = await runProductReview(await workspace.state(), {});
    if (!bundle.ok) throw new Error(bundle.error.message);
    const image = bundle.value.images.find((entry) => entry.route === "check C001: out/scene.png");
    if (!image) throw new Error("the check image was not delivered");
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
