import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * The dashboard listens on loopback only. These checks keep other web pages
 * the person has open from reading it: a token only the launching terminal
 * saw, a Host allowlist against DNS rebinding, and an Origin check on writes.
 */

export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Cookies ignore ports, so two dashboards on one machine each need their own name. */
export function cookieName(port: number): string {
  return `visp_ui_${port}`;
}

export function allowedHosts(port: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function hostAllowed(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  return host !== undefined && allowedHosts(port).has(host.toLowerCase());
}

export function originAllowed(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  return [...allowedHosts(port)].some((host) => origin.toLowerCase() === `http://${host}`);
}

export function tokensMatch(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function sessionCookie(port: number, token: string): string {
  return `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};
