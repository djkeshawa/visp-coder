/**
 * Tests describe VISP's own behavior, not the host running them. When the suite runs
 * inside a Codex or Claude Code session, these variables point at that session's real
 * prompts (a Codex thread's rollout, for example), and fixtures that expect a synthetic
 * request read the live one instead. Tests that need them stub them explicitly.
 */
for (const name of [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDECODE",
]) {
  delete process.env[name];
}
