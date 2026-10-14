import { readFile } from "node:fs/promises";
import { afterEach, it, vi } from "vitest";
import { GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * Review delegated to the worker's host (`critic.launch: host`, the Claude Code default): what
 * `visp next` asks for once checks pass, and the reviewer packets VISP prepares for the host's
 * reviewer without starting a model.
 */
let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("prepares the host reviewer's handoff and session packet", async () => {
  project = await GoldenProject.create({
    harness: "claude-code",
    critic: { enabled: true, harness: "claude-code" },
  });
  const run = new Recorder(project, "host-review/claude-code");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await project.writeBrief();
  await run.cli("02-work", ["work"]);
  await project.setValue(2);
  await run.cli("03-done", ["done"]);
  await run.cli("04-next-review-pending", ["next"]);
  await run.mcp("04-next-review-pending", "visp_next");
  await run.cli("05-review-handoff", ["review", "--handoff"]);
  const prepared = await run.cli("06-review-prepare", ["review", "--prepare"]);
  const { packetPath } = JSON.parse(prepared.stdout.slice(0, prepared.stdout.indexOf("\n}\n") + 2));
  await run.save("06-review-prepare.packet.json", await readFile(packetPath, "utf8"));
  await run.cli("07-next", ["next"]);
  await run.cli("08-critic-preflight", ["critic", "--preflight"]);
  await run.cli("09-critic-dispatch", ["critic", "--dispatch"]);
  await project.workspace.write(
    ".visp/drafts/capabilities.json",
    JSON.stringify({
      harness: "claude-code",
      model: "claude-sonnet-5",
      reasoningEffort: "high",
      freshContext: true,
      readOnly: true,
      images: false,
      delegationAllowed: true,
    }),
  );
  const native = await run.cli("10-critic-prepare", [
    "critic",
    "--prepare",
    "--capabilities",
    ".visp/drafts/capabilities.json",
  ]);
  const nativePacket = /"packetPath": "([^"]+)"/.exec(native.stdout)?.[1];
  if (nativePacket)
    await run.save("10-critic-prepare.packet.json", await readFile(nativePacket, "utf8"));
  // A reserved review is pending: next waits for it until its deadline, then says to wait.
  // The CLI's deadline counts from process start, so a long-lived process is already past it.
  const uptime = vi.spyOn(process, "uptime").mockReturnValue(1_000_000);
  await run.cli("11-next-review-running", ["next"]);
  uptime.mockRestore();
  await run.mcp("11-next-review-running", "visp_next", {}, { aborted: true });
  const attempt = /"attempt": "([^"]+)"/.exec(native.stdout)?.[1] ?? "missing";
  await run.cli("12-critic-failure", [
    "critic",
    "--attempt",
    attempt,
    "--failure",
    "The host refused to delegate the review",
  ]);
  await run.cli("13-next", ["next"]);
});
