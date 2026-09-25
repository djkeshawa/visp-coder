import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";

// Digests reported on the corresponding GitHub prerelease assets.
const released = {
  "0.4.0-beta.2": "3f7111c895689141b7f89ffcdbbe4068f993564c0ece35336f3ca2f811632586",
  "0.4.0-beta.3": "e0b5b1d766d0ec3133303a4b58a5f2af4a691e8be8d25f6bf9ab15dd64378dbf",
};

const [version, archive] = process.argv.slice(2);
assert(
  Object.hasOwn(released, version) && archive && isAbsolute(archive),
  "Usage: node scripts/verify-published-predecessor.mjs <0.4.0-beta.2|0.4.0-beta.3> /absolute/path/to/archive.tgz",
);

const bytes = await readFile(archive);
const digest = createHash("sha256").update(bytes).digest("hex");
assert.equal(digest, released[version], "Archive does not match the published GitHub release asset");

const tar = gunzipSync(bytes);
const entries = new Map();
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) break;
  const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
  const sizeText = header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
  const size = Number.parseInt(sizeText, 8);
  assert(Number.isSafeInteger(size) && size >= 0, `Invalid archive entry size: ${name}`);
  const start = offset + 512;
  assert(start + size <= tar.length, `Truncated archive entry: ${name}`);
  entries.set(name, tar.subarray(start, start + size));
  offset = start + Math.ceil(size / 512) * 512;
}
assert(entries.has("package/package.json"), "Published archive lacks its manifest");
const manifest = JSON.parse(entries.get("package/package.json").toString("utf8"));
assert.equal(manifest.name, "visp-coder");
assert.equal(manifest.version, version);
assert.equal(manifest.bin?.visp, "./dist/cli.js");
assert(entries.has("package/dist/cli.js"), "Published archive lacks its declared CLI");

console.log(JSON.stringify({ version, archive, sha256: digest, cli: manifest.bin.visp }));
