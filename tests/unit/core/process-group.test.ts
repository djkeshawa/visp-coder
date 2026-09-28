import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { run } from "../../../src/core/exec.js";

it.skipIf(process.platform === "win32")(
  "kills descendants that ignore SIGTERM after their parent exits",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "visp-process-group-"));
    let pid: number | undefined;
    try {
      const grandchild =
        "process.on('SIGTERM', () => {}); require('fs').writeFileSync('heartbeat', 'ready'); setInterval(() => require('fs').writeFileSync('heartbeat', String(Date.now())), 20); console.log('ready');";
      const script = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: ['ignore', 'pipe', 'inherit']}); child.stdout.once('data', () => { console.log(child.pid); process.exit(0); });`;
      const result = await run(process.execPath, ["-e", script], { cwd: root, timeoutMs: 1500 });
      if (!result.ok) throw new Error(result.error.message);
      pid = Number(result.value.stdout.trim());
      expect(result.value.exitCode).toBe(0);
      expect(result.value.durationMs).toBeLessThan(1000);
      const before = await readFile(join(root, "heartbeat"), "utf8");
      await delay(150);
      expect(await readFile(join(root, "heartbeat"), "utf8")).toBe(before);
    } finally {
      if (pid && Number.isFinite(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
