import { readFile, readlink } from "node:fs/promises";

/** Linux start ticks are stable across PID reuse; namespace identity prevents cross-sandbox guesses. */
export async function processIdentity(pid: number): Promise<{
  processStart?: string;
  bootId?: string;
  pidNamespace?: string;
}> {
  if (process.platform !== "linux") return {};
  const [stat, bootId, pidNamespace] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined),
    readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => undefined),
    readlink("/proc/self/ns/pid").catch(() => undefined),
  ]);
  return {
    processStart: stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
    bootId: bootId?.trim(),
    pidNamespace,
  };
}

/** Whether a process with this pid exists; one owned by another user still counts. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}
