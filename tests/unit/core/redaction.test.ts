import { homedir, tmpdir } from "node:os";
import { expect, it } from "vitest";
import { redactRequest, redactStrings, redactText } from "../../../src/core/redaction.js";

it("masks long environment values, short credentials, token patterns and local paths", () => {
  const root = `${tmpdir()}/redaction-project`;
  const text = `a-long-ordinary-value pin7 ghp_abcdefghijklmnopqrstuvwxyz123456 /local ${root}/app.ts ${homedir()}/.agents/skill.md ${tmpdir()}/test`;
  const safe = redactText(text, {
    root,
    environment: { ORDINARY: "a-long-ordinary-value", PASSWORD: "pin7" },
  });
  expect(safe).toBe(
    "[REDACTED] [REDACTED] [REDACTED] /local <project>/app.ts ~/.agents/skill.md <tmp>/test",
  );
});

it("masks high entropy credentials while preserving readable diagnostics", () => {
  expect(
    redactText("Deploy AbCdEfGhIjKlMnOpQrStUvWxYz0123456789; test failed", { environment: {} }),
  ).toBe("Deploy [REDACTED]; test failed");
});

it("keeps activity JSON valid when credentials include quotes", () => {
  const original = process.env.PRIVACY_TEST_PASSWORD;
  process.env.PRIVACY_TEST_PASSWORD = 'quote"secret';
  try {
    const redacted = redactStrings({ command: 'print quote"secret', count: 1 }, "/project");
    expect(JSON.parse(JSON.stringify(redacted))).toEqual({ command: "print [REDACTED]", count: 1 });
  } finally {
    if (original === undefined) delete process.env.PRIVACY_TEST_PASSWORD;
    else process.env.PRIVACY_TEST_PASSWORD = original;
  }
});

it("masks pasted credential assignments even when they are not in the environment", () => {
  expect(
    redactText('DEPLOY_SECRET="human readable secret"; api key is short-key', { environment: {} }),
  ).toBe('DEPLOY_SECRET="[REDACTED]"; api key is [REDACTED]');
});

it("redacts a full secret containing a local path before abbreviating that path", () => {
  expect(
    redactText("/project/credential /project/app.ts", {
      root: "/project",
      environment: { API_KEY: "/project/credential", PWD: "/project" },
    }),
  ).toBe("[REDACTED] <project>/app.ts");
});

it("preserves technical prose and ordinary environment names in the request", () => {
  expect(redactRequest("The next token is Identifier; use development mode.")).toBe(
    "The next token is Identifier; use development mode.",
  );
});
