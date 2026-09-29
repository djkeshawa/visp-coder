import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  outputRedactor,
  redactRequest,
  redactStrings,
  redactText,
} from "../../../src/core/redaction.js";

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

it("keeps ordinary settings readable so test names survive redaction", () => {
  const environment = {
    NODE_ENV: "production",
    COLORTERM: "truecolor",
    SHELL: "/bin/bash",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_GB.UTF-8",
    XDG_SESSION_TYPE: "wayland-session",
  };
  const text =
    "FAIL: production build works (truecolor, en_US.UTF-8, en_GB.UTF-8, wayland-session)";
  expect(redactText(text, { environment })).toBe(text);
});

it("masks identity data and names outside the explicit allowlist", () => {
  const environment = {
    USER: "developer1",
    LOGNAME: "developer2",
    HOSTNAME: "build-host-7",
    LC_MY: "custom-value-1",
    XDG_TOKENISH: "abc",
    XDG_UNLISTED_DIR: "unlisted-value",
  };
  const safe = redactText(
    "developer1 developer2 build-host-7 custom-value-1 abc unlisted-value stays",
    { environment },
  );
  expect(safe).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] stays");
});

it("masks a credential-shaped value even under an allowlisted name", () => {
  const environment = {
    LANG: "postgres://app:hunter22@db.internal/app",
    EDITOR: "operator@example.com",
    TERM: "abcdefghijklmnopqrstuvwxyz0123456789",
    NODE_ENV: "production",
  };
  const safe = redactText(
    "postgres://app:hunter22@db.internal/app operator@example.com abcdefghijklmnopqrstuvwxyz0123456789 production",
    { environment },
  );
  expect(safe).toBe("[REDACTED] [REDACTED] [REDACTED] production");
});

it("still masks secrets whatever their name or length", () => {
  const environment = {
    API_TOKEN: "abc",
    DATABASE_URL: "postgres://app:hunter22@db.internal/app",
    STRIPE_KEY: "sk_live_0123456789abcdef",
    NODE_ENV: "production",
  };
  const safe = redactText(
    "token abc url postgres://app:hunter22@db.internal/app key sk_live_0123456789abcdef in production",
    { environment },
  );
  expect(safe).toBe("token [REDACTED] url [REDACTED] key [REDACTED] in production");
  expect(redactText("value abc", { environment: { NODE_ENV_SECRET: "abc" } })).toBe(
    "value [REDACTED]",
  );
});

it("applies the same allowlist to values read from a project .env file", async () => {
  const root = await mkdtemp(`${tmpdir()}/visp-redact-`);
  try {
    await writeFile(
      `${root}/.env`,
      "NODE_ENV=production\nAPI_TOKEN=abc\nDATABASE_URL=postgres://app:hunter22@db/app\n",
    );
    const redact = await outputRedactor(root);
    expect(redact("FAIL: production build works; abc; postgres://app:hunter22@db/app")).toBe(
      "FAIL: production build works; [REDACTED]; [REDACTED]",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

// A browser check's output lists its run and capture IDs; replay and review resolve them.
it("keeps VISP evidence identities readable", () => {
  const output = JSON.stringify({
    status: "completed",
    runId: "CAPRUN-214c973b-9f2b-4b34-b48a-a149c455c902",
    captures: [
      "CAP-dfec4717-9c15-40fb-91be-fc27c24170fe",
      "CAP-bbb57ca2-6912-4b2b-aaa1-b8317df5b114",
    ],
    candidate: "CAN-0123456789abcdef0123456789abcdef",
  });
  expect(redactText(output)).toBe(output);
  expect(redactText("key sk-live-Zq8LmN3pRt6VwX9yB2cD5fG7hJ1kL4mN")).toContain("[REDACTED]");
  expect(redactText("CAP-Zq8LmN3pRt6VwX9yB2cD5fG7hJ1kL4mNq")).toContain("[REDACTED]");
});
