import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const failure = (message) => new Error(`Claude credential coordination: ${message}`);

async function privateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || await realpath(path) !== path)
    throw failure("a canonical regular credential file is required");
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw failure("credential file must be private and owned by the current user");
  if (info.size > 1024 * 1024) throw failure("credential file exceeds the size limit");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

function parse(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw failure("invalid credential JSON"); }
  const oauth = value?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken.trim() ||
      typeof oauth.refreshToken !== "string" || !oauth.refreshToken.trim() ||
      !Number.isSafeInteger(oauth.expiresAt) || oauth.expiresAt <= 0)
    throw failure("missing or invalid OAuth credential fields");
  return value;
}

async function atomicReplace(source, bytes) {
  const temporary = `${source}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(temporary, source);
    const directory = await open(dirname(source), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

async function preserveRefresh(source, destination, initial) {
  const current = await privateFile(source);
  if (!current.equals(initial)) throw failure("source changed outside the lease; retain the private credential for recovery");
  const candidate = await privateFile(destination);
  if (candidate.equals(initial)) return "unchanged";
  const original = parse(initial);
  const refreshed = parse(candidate).claudeAiOauth;
  if (JSON.stringify(refreshed) === JSON.stringify(original.claudeAiOauth)) return "unchanged";
  if (refreshed.expiresAt <= Date.now() || refreshed.expiresAt <= original.claudeAiOauth.expiresAt ||
      refreshed.subscriptionType !== original.claudeAiOauth.subscriptionType ||
      refreshed.rateLimitTier !== original.claudeAiOauth.rateLimitTier)
    throw failure("refreshed credential expiry or account metadata is inconsistent; retain the private credential for recovery");
  // Only the native OAuth entry may change; private settings/history never flow back.
  const replacement = Buffer.from(JSON.stringify({ ...original, claudeAiOauth: refreshed }));
  if (!(await privateFile(source)).equals(initial)) throw failure("source changed outside the lease");
  await atomicReplace(source, replacement);
  return "refreshed";
}

/** Cooperative single-writer lease held for the entire native attempt, including failure cleanup.
 * Other account clients must be idle: this lease cannot coordinate an unrelated native login.
 * A crash leaves the lease and isolated credentials for explicit recovery; never steal it by age.
 * No credential bytes, hashes, or native error text are included in the returned receipt.
 */
export async function withClaudeCredentials({ source, destination }, run) {
  if (!isAbsolute(source) || !isAbsolute(destination) || source === destination)
    throw failure("distinct absolute source and destination paths are required");
  const initial = await privateFile(source);
  parse(initial);
  const lease = `${source}.visp-lease`;
  try { await mkdir(lease, { mode: 0o700 }); }
  catch { throw failure("credential lease exists or cannot be acquired; inspect ownership before recovery"); }
  const owner = randomUUID();
  let recoveryRequired = false;
  try {
    await writeFile(`${lease}/owner.json`, JSON.stringify({ owner, pid: process.pid }), { flag: "wx", mode: 0o600 });
    if (!(await privateFile(source)).equals(initial)) throw failure("source changed outside the lease");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(destination));
    if (await realpath(dirname(destination)) !== dirname(destination) || (directory.mode & 0o077) !== 0)
      throw failure("isolated credential destination directory must be canonical and private");
    try { await writeFile(destination, initial, { flag: "wx", mode: 0o600 }); }
    catch { throw failure("credential destination already exists or cannot be created"); }
    let value;
    let hostFailure;
    let failed = false;
    try { value = await run(); } catch (error) { failed = true; hostFailure = error; }
    let synchronization;
    try { synchronization = await preserveRefresh(source, destination, initial); }
    catch (error) { recoveryRequired = true; throw error; }
    if (failed) throw hostFailure;
    return { value, credentialReceipt: { schemaVersion: 1, synchronization, serverValidity: "not-probed" } };
  } finally {
    const recorded = JSON.parse(await readFile(`${lease}/owner.json`, "utf8"));
    if (recorded.owner !== owner) throw failure("lease ownership changed; explicit recovery required");
    if (!recoveryRequired) {
      await rm(`${lease}/owner.json`);
      await rmdir(lease);
    }
  }
}
