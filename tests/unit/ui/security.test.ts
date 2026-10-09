import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  cookieName,
  hostAllowed,
  originAllowed,
  readCookie,
  sessionCookie,
  tokensMatch,
} from "../../../src/ui/security.js";

const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe("request checks", () => {
  it("accepts only loopback hosts on the dashboard's own port", () => {
    expect(hostAllowed(request({ host: "127.0.0.1:4417" }), 4417)).toBe(true);
    expect(hostAllowed(request({ host: "LOCALHOST:4417" }), 4417)).toBe(true);
    expect(hostAllowed(request({ host: "127.0.0.1:4418" }), 4417)).toBe(false);
    expect(hostAllowed(request({ host: "attacker.example:4417" }), 4417)).toBe(false);
    expect(hostAllowed(request({}), 4417)).toBe(false);
  });

  it("accepts writes only from the dashboard's own origin", () => {
    expect(originAllowed(request({ origin: "http://127.0.0.1:4417" }), 4417)).toBe(true);
    expect(originAllowed(request({ origin: "http://localhost:4417" }), 4417)).toBe(true);
    expect(originAllowed(request({ origin: "https://127.0.0.1:4417" }), 4417)).toBe(false);
    expect(originAllowed(request({ origin: "http://evil.example" }), 4417)).toBe(false);
    expect(originAllowed(request({}), 4417)).toBe(false);
  });

  it("compares tokens exactly", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "ab")).toBe(false);
    expect(tokensMatch("abc", undefined)).toBe(false);
  });
});

describe("session cookie", () => {
  it("names the cookie by port, because cookies are shared across ports", () => {
    expect(cookieName(4417)).not.toBe(cookieName(4418));
  });

  it("is HttpOnly and SameSite=Strict, and reads back from a Cookie header", () => {
    const cookie = sessionCookie(4417, "secret");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const header = `other=1; ${cookie.split(";")[0]}; visp_ui_4418=nope`;
    expect(readCookie(request({ cookie: header }), cookieName(4417))).toBe("secret");
    expect(readCookie(request({}), cookieName(4417))).toBeUndefined();
  });
});

it("allows scripts and connections only from the dashboard itself", () => {
  expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
  expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
  expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
  expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
});
