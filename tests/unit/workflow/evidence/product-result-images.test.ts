import { spawnSync } from "node:child_process";
import { readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  imageDimensions,
  imageMimeType,
} from "../../../../src/workflow/evidence/observations/media.js";
import {
  runProductReview,
  runProductVerify,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.destroy();
});

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

const chrome =
  spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--version"], { timeout: 10_000 })
    .status === 0;

async function working() {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const widened = await updateProductBrief(await workspace.state(), {
    brief: {
      ...brief,
      slices: brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: [...slice.scope.allowed, "art/**", "assets/**"] },
      })),
    },
    reason: "The slice also writes pictures",
  });
  if (!widened.ok) throw new Error(widened.error.message);
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  const work = await runProductWork(await workspace.state());
  if (!work.ok) throw new Error(work.error.message);
  return workspace;
}

type Capture = { id: string; path: string; route: string; subjectDigest: string };

async function captures(workspace: TestWorkspace): Promise<Capture[]> {
  const record = await readProductRecord(await workspace.state());
  if (!record.ok) throw new Error(record.error.message);
  return record.value.state.captures as Capture[];
}

describe("pictures the product makes", () => {
  it("reach the reviewer as images of the version whose checks passed, without a declaration", async () => {
    const workspace = await working();
    await workspace.write("art/scene.png", png(255, 0, 0));
    const verified = await runProductVerify(await workspace.state());
    expect(verified).toMatchObject({ ok: true, value: { passed: true } });
    if (!verified.ok) return;
    const [capture] = await captures(workspace);
    expect(capture).toMatchObject({
      route: "result image: art/scene.png",
      subjectDigest: verified.value.subjectDigest,
    });
    expect(await readFile(join(workspace.root, capture?.path ?? ""))).toEqual(png(255, 0, 0));
    const bundle = await runProductReview(await workspace.state(), {});
    if (!bundle.ok) throw new Error(bundle.error.message);
    expect(bundle.value.images.map((image) => image.id)).toContain(capture?.id);
  });

  it("are captured once per product version and again when the picture changes", async () => {
    const workspace = await working();
    await workspace.write("art/scene.png", png(255, 0, 0));
    for (let run = 0; run < 2; run += 1)
      expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    expect(await captures(workspace)).toHaveLength(1);
    await workspace.write("art/scene.png", png(0, 0, 255));
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    const all = await captures(workspace);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((capture) => capture.subjectDigest)).size).toBe(2);
  });

  it("leave out images that predate the feature and add nothing while a check fails", async () => {
    const workspace = await working();
    await workspace.write("assets/logo.png", png(0, 255, 0));
    const past = new Date("2020-01-01T00:00:00Z");
    await utimes(join(workspace.root, "assets/logo.png"), past, past);
    expect((await runProductVerify(await workspace.state())).ok).toBe(true);
    expect(await captures(workspace)).toEqual([]);

    await workspace.write("src/value.mjs", "export const value = 3;\n");
    await workspace.write("art/scene.png", png(255, 0, 0));
    const failing = await runProductVerify(await workspace.state());
    expect(failing).toMatchObject({ ok: true, value: { passed: false } });
    expect(await captures(workspace)).toEqual([]);
  });

  it.skipIf(!chrome)(
    "render an SVG in a browser, since reviewers cannot view SVG files",
    async () => {
      const workspace = await working();
      await workspace.write(
        "art/controller.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#1a3cff"/></svg>',
      );
      expect((await runProductVerify(await workspace.state())).ok).toBe(true);
      const [capture] = await captures(workspace);
      expect(capture?.route).toBe("result image: art/controller.svg");
      const bytes = await readFile(join(workspace.root, capture?.path ?? ""));
      expect(imageMimeType(bytes)).toBe("image/png");
      expect(imageDimensions(bytes)).toEqual({ width: 1024, height: 768 });
    },
  );
});
