import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { codexSessionPrompts } from "../../../../src/workflow/product/host-prompts.js";

// Codex workers passed short summaries as the verbatim request; Codex has no prompt hook,
// but commands see their session id and the session file records the user messages.
it("reads the user messages of the Codex session running the command", async () => {
  const home = await mkdtemp(join(tmpdir(), "visp-codex-session-"));
  const thread = "01a0d848-dc5d-7ef0-8a4f-d9e6a54948ef";
  const day = join(home, "sessions", "2026", "09", "25");
  await mkdir(day, { recursive: true });
  const user = (text: string) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text }] },
      },
    });
  await writeFile(
    join(day, `rollout-2026-09-25T16-47-28-${thread}.jsonl`),
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }],
        },
      }),
      user("Build the spreadsheet engine.\nContract: ..."),
      user("continue"),
    ].join("\n"),
  );
  expect(await codexSessionPrompts({ CODEX_THREAD_ID: thread, CODEX_HOME: home })).toEqual([
    "Build the spreadsheet engine.\nContract: ...",
    "continue",
  ]);
  expect(await codexSessionPrompts({ CODEX_THREAD_ID: "other", CODEX_HOME: home })).toEqual([]);
  expect(await codexSessionPrompts({ CODEX_HOME: home })).toEqual([]);
});
