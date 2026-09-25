import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ok } from "../../src/core/result.js";
import { withStateLock } from "../../src/core/state-lock.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const library = pathToFileURL(resolve("dist/index.js")).href;

it("coordinates separate processes without losing accepted read-modify-writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "visp-process-lock-"));
  roots.push(root);
  await writeFile(join(root, "counter"), "0");
  const source = `import { withStateLock, ok } from ${JSON.stringify(library)};
    import { readFile, writeFile } from 'node:fs/promises';
    const root = process.argv[1];
    for (let i=0; i<6; i++) {
      const result = await withStateLock(root, async () => {
        const value = Number(await readFile(root+'/counter', 'utf8'));
        await new Promise(r=>setTimeout(r, 5));
        await writeFile(root+'/counter', String(value+1)); return ok(undefined);
      }); if (!result.ok) throw new Error(JSON.stringify(result.error));
    }`;
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => child(source, root)));
  expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  expect(await readFile(join(root, "counter"), "utf8")).toBe("24");
});

it("recovers ownership only after the writer process has exited", async () => {
  const root = await mkdtemp(join(tmpdir(), "visp-dead-lock-"));
  roots.push(root);
  const source = `import { withStateLock } from ${JSON.stringify(library)};
    await withStateLock(process.argv[1], async () => { process.exit(0); });`;
  await child(source, root);
  expect(await withStateLock(root, async () => ok("recovered"))).toEqual(ok("recovered"));
});

function child(source: string, root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      ["--input-type=module", "-e", source, root],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let error = "";
    process.stderr.on("data", (data) => {
      error += String(data);
    });
    process.once("error", reject);
    process.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(error || `child exit ${code}`)),
    );
  });
}
