import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withClaudeCredentials } from "../../scripts/qualification/claude-credentials.mjs";

const credential = (generation = 1) => ({
  unrelated: { preserve: true },
  claudeAiOauth: {
    accessToken: `fixture-access-${generation}`, refreshToken: `fixture-refresh-${generation}`,
    expiresAt: Date.now() + generation * 3_600_000, subscriptionType: "fixture",
  },
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "visp-auth-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "credentials.json");
  await writeFile(source, JSON.stringify(credential()), { mode: 0o600 });
  return { root, source, destination: join(root, "attempt", ".credentials.json") };
}
const read = async (path) => JSON.parse(await readFile(path, "utf8"));

test("rotated credentials reach the next isolated attempt without sharing history", async (t) => {
  const f = await fixture(t);
  const rotated = credential(2);
  await withClaudeCredentials(f, async () => {
    await writeFile(f.destination, JSON.stringify({ ...rotated, unrelated: "untrusted change" }));
    await writeFile(join(f.root, "attempt", "history.json"), "private attempt history");
  });
  const second = { ...f, destination: join(f.root, "next", ".credentials.json") };
  await withClaudeCredentials(second, async () => {
    assert.deepEqual((await read(second.destination)).claudeAiOauth, rotated.claudeAiOauth);
    await assert.rejects(readFile(join(f.root, "next", "history.json")), { code: "ENOENT" });
  });
  assert.deepEqual((await read(f.source)).unrelated, { preserve: true });
  assert.equal((await stat(f.source)).mode & 0o777, 0o600);
});

test("a host failure still preserves a completed native refresh", async (t) => {
  const f = await fixture(t);
  const rotated = credential(2);
  await assert.rejects(withClaudeCredentials(f, async () => {
    await writeFile(f.destination, JSON.stringify(rotated));
    throw new Error("fixture host failure");
  }), /fixture host failure/);
  assert.deepEqual((await read(f.source)).claudeAiOauth, rotated.claudeAiOauth);
});

test("concurrent or abandoned credential leases stop before executing an attempt", async (t) => {
  const f = await fixture(t);
  let attempted = false;
  await withClaudeCredentials(f, async () => {
    await assert.rejects(withClaudeCredentials({ ...f, destination: join(f.root, "second", ".credentials.json") }, async () => { attempted = true; }), /lease/);
  });
  await mkdir(`${f.source}.visp-lease`, { mode: 0o700 });
  await assert.rejects(withClaudeCredentials(f, async () => { attempted = true; }), /lease/);
  assert.equal(attempted, false);
});

test("external source updates are preserved and refreshed private credentials remain recoverable", async (t) => {
  const f = await fixture(t);
  const external = credential(3);
  await assert.rejects(withClaudeCredentials(f, async () => {
    await writeFile(f.destination, JSON.stringify(credential(2)));
    await writeFile(f.source, JSON.stringify(external));
  }), /changed outside/);
  assert.deepEqual(await read(f.source), external);
  assert.equal((await read(f.destination)).claudeAiOauth.accessToken, "fixture-access-2");
  await assert.rejects(withClaudeCredentials({ ...f, destination: join(f.root, "next", ".credentials.json") }, async () => assert.fail("must not dispatch after a refresh conflict")), /lease/);
});

test("cleared, malformed, expired, or different-account refreshes cannot replace the source", async (t) => {
  for (const invalid of ["{bad", "{}", JSON.stringify(credential(0)), JSON.stringify({ ...credential(2), claudeAiOauth: { ...credential(2).claudeAiOauth, subscriptionType: "changed" } })]) {
    const f = await fixture(t);
    const original = await readFile(f.source, "utf8");
    await assert.rejects(withClaudeCredentials(f, async () => writeFile(f.destination, invalid)), /credential/);
    assert.equal(await readFile(f.source, "utf8"), original);
  }
});

test("symlinks and existing destinations are refused without exposing credential contents", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "alias");
  await symlink(f.source, alias);
  await assert.rejects(withClaudeCredentials({ ...f, source: alias }, async () => {}), /regular|canonical/);
  await withClaudeCredentials(f, async () => {});
  await assert.rejects(withClaudeCredentials(f, async () => {}), /destination/);
});
