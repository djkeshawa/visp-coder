import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * A running dashboard records where it listens so a second `visp ui` in the same
 * repository reopens it instead of starting another. The record lives in a
 * per-user directory outside the repository: it holds the session token, which
 * must never be committed or read by another account.
 */
export interface Lease {
  readonly root: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly buildId: string;
}

export function leaseDir(): string {
  const base = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  return join(base, `visp-ui-${safeUser()}`);
}

function safeUser(): string {
  try {
    return String(userInfo().uid >= 0 ? userInfo().uid : userInfo().username);
  } catch {
    return "user";
  }
}

export function leasePath(root: string, dir = leaseDir()): string {
  return join(dir, `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`);
}

export async function writeLease(lease: Lease, dir = leaseDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await privateDirectory(dir))) return;
  await writeFile(leasePath(lease.root, dir), JSON.stringify(lease), { mode: 0o600 });
}

/**
 * In a shared temporary directory another account could create this directory
 * first and plant a lease pointing at its own server. Trust it only when it is a
 * real directory this account owns that nobody else can write to.
 */
export async function privateDirectory(dir: string): Promise<boolean> {
  const info = await lstat(dir).catch(() => undefined);
  if (!info?.isDirectory()) return false;
  if (process.platform === "win32") return true;
  return info.uid === process.getuid?.() && (info.mode & 0o022) === 0;
}

export async function readLease(root: string, dir = leaseDir()): Promise<Lease | undefined> {
  if (!(await privateDirectory(dir))) return undefined;
  try {
    const value = JSON.parse(await readFile(leasePath(root, dir), "utf8")) as Partial<Lease>;
    if (
      value.root === root &&
      typeof value.pid === "number" &&
      typeof value.port === "number" &&
      typeof value.token === "string" &&
      typeof value.buildId === "string"
    )
      return value as Lease;
  } catch {
    // Missing or unreadable: there is no running dashboard to reuse.
  }
  return undefined;
}

export async function removeLease(root: string, dir = leaseDir()): Promise<void> {
  await rm(leasePath(root, dir), { force: true });
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lease is reusable only if its server answers as the same build. */
export async function reusableLease(root: string, buildId: string): Promise<Lease | undefined> {
  const lease = await readLease(root);
  if (!lease || lease.buildId !== buildId || !processAlive(lease.pid)) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${lease.port}/api/v1/ping`, {
      signal: AbortSignal.timeout(1_000),
    });
    const body = (await response.json()) as { data?: { buildId?: string } };
    return body.data?.buildId === buildId ? lease : undefined;
  } catch {
    return undefined;
  }
}
