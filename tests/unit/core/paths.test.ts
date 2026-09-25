import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isInside, ProjectPaths, toPosix } from "../../../src/core/paths.js";

const root = resolve("/repo");
const paths = new ProjectPaths(root);

describe("ProjectPaths", () => {
  it("places config at the project root and state under .visp", () => {
    expect(paths.config).toBe(join(root, "visp.yml"));
    expect(paths.state).toBe(join(root, ".visp"));
  });

  it("builds feature-scoped artifact paths", () => {
    expect(paths.featureFile("001-login", "spec.json")).toBe(
      join(root, ".visp", "features", "001-login", "spec.json"),
    );
  });

  it("keeps context packs under their owning feature", () => {
    expect(paths.contextFile("001-login", "T001")).toBe(
      join(root, ".visp", "features", "001-login", "context", "T001.json"),
    );
  });

  it("keeps observations and probes under their task evidence directory", () => {
    expect(paths.evidenceFile("001-login", "T001", "observations.json")).toBe(
      join(root, ".visp", "features", "001-login", "evidence", "T001", "observations.json"),
    );
    expect(paths.evidenceFile("001-login", "T001", "probes.json")).toBe(
      join(root, ".visp", "features", "001-login", "evidence", "T001", "probes.json"),
    );
    expect(paths.observationAttachmentsDir("001-login", "T001", "obs-1")).toBe(
      join(
        root,
        ".visp",
        "features",
        "001-login",
        "evidence",
        "T001",
        "observations",
        "obs-1",
        "attachments",
      ),
    );
  });

  it("gives each task its own implement marker", () => {
    expect(paths.implementMarker("T001")).toBe(
      join(root, ".visp", "state", "implement-allowed", "T001.json"),
    );
  });

  it("resolves a relative path against the root", () => {
    expect(paths.absolute("src/index.ts")).toBe(join(root, "src", "index.ts"));
  });

  it("rejects absolute and escaping repository-relative paths", () => {
    expect(() => paths.absolute("/outside.txt")).toThrow(/relative/i);
    expect(() => paths.absolute("../outside.txt")).toThrow(/outside/i);
    expect(() => paths.absolute("src/../outside.txt")).toThrow(/traversal/i);
  });

  it("rejects malformed dynamic path segments", () => {
    expect(() => paths.featureDir("../outside")).toThrow(/feature/i);
    expect(() => paths.implementMarker("../../T001")).toThrow(/task/i);
    expect(() => paths.featureFile("001-safe", "../artifact.json")).toThrow(/name/i);
    expect(() => paths.evidenceAttemptsDir("001-safe", "T001", "../review.json")).toThrow(/name/i);
  });

  it("builds a content-addressed observation attachment path", () => {
    expect(paths.observationAttachmentBlob("001-login", "a".repeat(64), ".png")).toBe(
      join(
        root,
        ".visp",
        "features",
        "001-login",
        "evidence",
        "observation-attachments",
        `${"a".repeat(64)}.png`,
      ),
    );
  });

  it("keeps quarantined evidence under the operation while preserving its original path", () => {
    expect(paths.evidenceQuarantineFile("operation-1", ".visp/features/001-login/file.bin")).toBe(
      join(
        root,
        ".visp",
        "state",
        "evidence-quarantine",
        "operation-1",
        ".visp",
        "features",
        "001-login",
        "file.bin",
      ),
    );
    expect(() => paths.evidenceQuarantineFile("../escape", "file.bin")).toThrow(/operation/i);
    expect(() => paths.evidenceQuarantineFile("operation-1", "../file.bin")).toThrow(/traversal/i);
  });

  it("returns a POSIX relative path for a path inside the project", () => {
    expect(paths.relative(join(root, "src", "index.ts"))).toBe("src/index.ts");
  });

  it("returns undefined for a path outside the project", () => {
    expect(paths.relative("/elsewhere/file.ts")).toBeUndefined();
  });

  it("reports the root itself as '.'", () => {
    expect(paths.relative(root)).toBe(".");
  });
});

describe("isInside", () => {
  it("accepts a nested path and the directory itself", () => {
    expect(isInside("/repo", "/repo/src/a.ts")).toBe(true);
    expect(isInside("/repo", "/repo")).toBe(true);
  });

  it("rejects a sibling or an escaping path", () => {
    expect(isInside("/repo", "/other/a.ts")).toBe(false);
    expect(isInside("/repo", "/repo/../other")).toBe(false);
  });
});

describe("toPosix", () => {
  it("leaves a POSIX path unchanged", () => {
    expect(toPosix("src/index.ts")).toBe("src/index.ts");
  });
});
