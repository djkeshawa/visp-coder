import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { privateDirectory, readLease, writeLease } from "../../../src/ui/lease.js";

let base: string;
const lease = { root: "/repo", pid: process.pid, port: 4417, token: "t", buildId: "b" };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "visp-ui-lease-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

it("writes a lease only the owner can read and reads it back for the same repository", async () => {
  const dir = join(base, "leases");
  await writeLease(lease, dir);
  expect(await privateDirectory(dir)).toBe(true);
  expect(await readLease("/repo", dir)).toEqual(lease);
  expect(await readLease("/other", dir)).toBeUndefined();
});

it.skipIf(process.platform === "win32")(
  "ignores a lease directory that other accounts can write to",
  async () => {
    const dir = join(base, "leases");
    await writeLease(lease, dir);
    await chmod(dir, 0o777);
    expect(await privateDirectory(dir)).toBe(false);
    expect(await readLease("/repo", dir)).toBeUndefined();
  },
);
