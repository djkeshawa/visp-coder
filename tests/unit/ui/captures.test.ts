import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCaptures, readCapture } from "../../../src/ui/captures.js";

let featureDir: string;
let outside: string;

beforeEach(async () => {
  featureDir = await mkdtemp(join(tmpdir(), "visp-ui-feature-"));
  outside = await mkdtemp(join(tmpdir(), "visp-ui-outside-"));
  await mkdir(join(featureDir, "captures", "run-1"), { recursive: true });
  await writeFile(join(featureDir, "captures", "run-1", "start.png"), "png-bytes");
  await writeFile(join(featureDir, "captures", "run-1", "notes.txt"), "not an image");
  await writeFile(join(outside, "secret.png"), "outside");
});

afterEach(async () => {
  await rm(featureDir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("readCapture", () => {
  it("serves an image inside the feature's captures", async () => {
    const read = await readCapture(featureDir, "run-1/start.png");
    expect(read).toMatchObject({ ok: true, contentType: "image/png" });
    expect(read.ok && read.body.toString()).toBe("png-bytes");
  });

  it("refuses traversal, absolute paths and files that are not images", async () => {
    for (const path of ["../secret.png", "run-1/../../x.png", "/etc/passwd.png", "run-1/notes.txt"])
      expect(await readCapture(featureDir, path)).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a symlink anywhere in the path", async () => {
    await symlink(join(outside, "secret.png"), join(featureDir, "captures", "run-1", "link.png"));
    await symlink(outside, join(featureDir, "captures", "linked-dir"));
    expect(await readCapture(featureDir, "run-1/link.png")).toMatchObject({ ok: false });
    expect(await readCapture(featureDir, "linked-dir/secret.png")).toMatchObject({ ok: false });
  });

  it("answers not found for a missing file", async () => {
    expect(await readCapture(featureDir, "run-1/missing.png")).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

it("lists only real images, and never follows a link out of the captures", async () => {
  await symlink(outside, join(featureDir, "captures", "linked-dir"));
  const captures = await listCaptures(featureDir);
  expect(captures.map((capture) => capture.path)).toEqual(["run-1/start.png"]);
});

it("lists nothing when a feature has no captures", async () => {
  const empty = await mkdtemp(join(tmpdir(), "visp-ui-empty-"));
  expect(await listCaptures(empty)).toEqual([]);
  await rm(empty, { recursive: true, force: true });
});
