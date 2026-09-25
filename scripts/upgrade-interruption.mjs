import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

// Test-only preload: terminate the installed executable after a real state rename.
// No candidate source or installed module is patched, and no model is invoked.
export async function interruptInstalledMigration({ binary, root, scratch, statePath, originalText, env }) {
  const preload = join(scratch, "interrupt-migration.mjs");
  await writeFile(preload, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (...args) => {
  const result = await rename(...args);
  if (String(args[1]) === process.env.VISP_UPGRADE_INTERRUPT_STATE)
    process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
`);
  assert.equal(await readFile(statePath, "utf8"), originalText);
  let termination;
  try {
    execFileSync(process.execPath, ["--import", preload, binary, "--project", root, "apply"], {
      cwd: root,
      env: { ...env, VISP_UPGRADE_INTERRUPT_STATE: statePath },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    termination = error;
  }
  assert.equal(termination?.signal, "SIGKILL", "Must terminate at the injected write boundary");
  const partial = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(partial.version, 3, "State must actually have been upgraded before termination");
  const directory = join(root, ".visp/state/transactions");
  const journals = await readdir(directory);
  assert.equal(journals.length, 1);
  const journalPath = join(directory, journals[0]);
  const journalText = await readFile(journalPath, "utf8");
  const journal = JSON.parse(journalText);
  assert.equal(journal.state, "prepared", "Termination must precede transaction commit");
  assert.equal(journal.label, "standalone-product-migration");
  const stateEntry = journal.entries.find((entry) => entry.path === relative(root, statePath));
  assert.equal(Buffer.from(stateEntry.before.content, "base64").toString(), originalText);
  const backupEntry = journal.entries.find((entry) => entry.path.startsWith(".visp/migrations/backups/"));
  assert(backupEntry, "Original history backup must belong to the same transaction");
  const backupPath = join(root, backupEntry.path);
  const backupText = await readFile(backupPath, "utf8");
  const backup = JSON.parse(backupText);
  const preserved = backup.files.find((file) => file.path === relative(root, statePath));
  assert.equal(Buffer.from(preserved.contentBase64, "base64").toString(), originalText);
  return { directory, journalPath, journalText, backupPath, backupText };
}

export async function assertRecoveredMigration(interrupted) {
  assert.equal(await readFile(interrupted.backupPath, "utf8"), interrupted.backupText);
  const remaining = await readdir(interrupted.directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(remaining, [], "Restart must recover and clear the interrupted transaction");
}
