import { describe, expect, it } from "vitest";
import { checkPaths, decideScope, missingExpectedFiles } from "../../../src/orchestrate/guard.js";
import type { ImplementMarker } from "../../../src/workflow/artifacts/evidence.js";

function marker(overrides: Partial<ImplementMarker> = {}): ImplementMarker {
  return {
    kind: "implement-marker",
    createdAt: "2026-01-01T00:00:00.000Z",
    feature: "001-login",
    task: "T001",
    allowedFiles: ["src/auth/**/*.ts"],
    expectedFiles: ["src/auth/login.ts"],
    forbiddenFiles: [],
    ...overrides,
  };
}

const blockedPaths = [".env", ".env.*", "node_modules", "dist"];

describe("decideScope", () => {
  it("allows a path inside the task's allowed files", () => {
    const decision = decideScope({
      path: "src/auth/login.ts",
      markers: [marker()],
      blockedPaths,
    });
    expect(decision.allowed).toBe(true);
  });

  it("refuses a path outside the allowed files and says which task was checked", () => {
    const decision = decideScope({
      path: "src/billing/invoice.ts",
      markers: [marker()],
      blockedPaths,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("outside-allowed-files");
    expect(decision.message).toContain("T001");
  });

  it("refuses a blocked path even when a task would allow it", () => {
    const decision = decideScope({
      path: ".env",
      markers: [marker({ allowedFiles: ["**/*"] })],
      blockedPaths,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("blocked-path");
  });

  it("lets forbidden files win over allowed files", () => {
    const decision = decideScope({
      path: "src/auth/secrets.ts",
      markers: [marker({ forbiddenFiles: ["src/auth/secrets.ts"] })],
      blockedPaths,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("forbidden-file");
  });

  it("refuses everything when no task is authorized", () => {
    const decision = decideScope({ path: "src/auth/login.ts", markers: [], blockedPaths });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("no-authorization");
  });

  it("allows writes to the tool's own state directory", () => {
    const decision = decideScope({ path: ".visp/status.json", markers: [], blockedPaths });
    expect(decision.allowed).toBe(true);
  });

  it.each([
    ".visp/../src/auth/login.ts",
    ".visp\\..\\src\\auth\\login.ts",
    "../src/auth/login.ts",
    "/tmp/login.ts",
    "C:\\tmp\\login.ts",
    "\\\\server\\share\\login.ts",
    "",
  ])("refuses a non-confined path before applying exemptions: %j", (path) => {
    const decision = decideScope({
      path,
      markers: [marker({ allowedFiles: ["**/*"] })],
      blockedPaths,
      enforceAllowedFiles: false,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("invalid-path");
  });

  it("canonicalizes benign dot and repeated separators before matching", () => {
    const decision = decideScope({
      path: "./src//auth/./login.ts",
      markers: [marker()],
      blockedPaths,
    });
    expect(decision.allowed).toBe(true);
  });

  it("accepts a path allowed by any one of several active tasks", () => {
    const decision = decideScope({
      path: "src/billing/invoice.ts",
      markers: [marker(), marker({ task: "T002", allowedFiles: ["src/billing/**/*.ts"] })],
      blockedPaths,
    });
    expect(decision.allowed).toBe(true);
  });

  it("lets one task's forbidden list block a path another task allows", () => {
    const decision = decideScope({
      path: "src/billing/invoice.ts",
      markers: [
        marker({ task: "T002", allowedFiles: ["src/billing/**/*.ts"] }),
        marker({ task: "T003", forbiddenFiles: ["src/billing/invoice.ts"] }),
      ],
      blockedPaths,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("forbidden-file");
  });

  it("normalizes a leading ./ before deciding", () => {
    const decision = decideScope({
      path: "./src/auth/login.ts",
      markers: [marker()],
      blockedPaths,
    });
    expect(decision.allowed).toBe(true);
  });
});

/**
 * `scope.allowed-files` is an overridable rule, so a recorded override has to
 * reach the mechanical check too — otherwise the documented escape hatch does
 * nothing where enforcement actually happens.
 */
describe("when scope.allowed-files is overridden", () => {
  it("allows a path outside the task's allowed files", () => {
    const decision = decideScope({
      path: "src/billing/invoice.ts",
      markers: [marker()],
      blockedPaths,
      enforceAllowedFiles: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it("still refuses a blocked path, which cannot be overridden", () => {
    const decision = decideScope({
      path: ".env",
      markers: [marker()],
      blockedPaths,
      enforceAllowedFiles: false,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("blocked-path");
  });

  it("still refuses a file the task explicitly forbids", () => {
    const decision = decideScope({
      path: "src/auth/secrets.ts",
      markers: [marker({ forbiddenFiles: ["src/auth/secrets.ts"] })],
      blockedPaths,
      enforceAllowedFiles: false,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("forbidden-file");
  });

  it("still refuses when no task is authorized at all", () => {
    const decision = decideScope({
      path: "src/auth/login.ts",
      markers: [],
      blockedPaths,
      enforceAllowedFiles: false,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("no-authorization");
  });
});

describe("checkPaths", () => {
  it("reports every violation, not just the first", () => {
    const violations = checkPaths([".env", "src/auth/login.ts", "src/billing/invoice.ts"], {
      markers: [marker()],
      blockedPaths,
    });
    expect(violations.map((violation) => violation.path)).toEqual([
      ".env",
      "src/billing/invoice.ts",
    ]);
  });

  it("returns nothing when every path is in scope", () => {
    const violations = checkPaths(["src/auth/login.ts"], { markers: [marker()], blockedPaths });
    expect(violations).toEqual([]);
  });
});

describe("missingExpectedFiles", () => {
  it("names expected files the change never touched", () => {
    expect(missingExpectedFiles(["src/auth/other.ts"], marker())).toEqual(["src/auth/login.ts"]);
  });

  it("returns nothing once the expected file appears", () => {
    expect(missingExpectedFiles(["src/auth/login.ts"], marker())).toEqual([]);
  });
});
