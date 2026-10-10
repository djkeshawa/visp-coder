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
      const result = await run(process.execPath, ["-e", script], { cwd: root, timeoutMs: 10_000 });
      if (!result.ok) throw new Error(result.error.message);
      pid = Number(result.value.stdout.trim());
      expect(result.value.exitCode).toBe(0);
      expect(result.value.timedOut).toBe(false);
      // The grandchild ignores SIGTERM and writes every 20 ms; once SIGKILLed it stops writing.
      const beat = () => readFile(join(root, "heartbeat"), "utf8");
      const deadline = Date.now() + 3000;
      let quiet = 0;
      let last = await beat();
      // Two unchanged 200 ms polls in a row: one equal pair could be a scheduling stall.
      while (quiet < 2 && Date.now() < deadline) {
        await delay(200);
        const current = await beat();
        quiet = current === last ? quiet + 1 : 0;
        last = current;
      }
      const stopped = quiet >= 2;
      expect(stopped).toBe(true);
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
