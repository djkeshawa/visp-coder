import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pinnedRange, runtimeIdentity } from "../../../src/core/version.js";

it("pins generated launchers to this package's CLI, not the embedding process", () => {
  expect(runtimeIdentity().executable).toBe(realpathSync(resolve("dist/cli.js")));
});

describe("generated CI version pinning", () => {
  it("pins stable releases to their compatible major and minor line", () => {
    expect(pinnedRange("1.7.4")).toBe("1.7");
  });

  it("pins prereleases exactly so npm can resolve the published build", () => {
    expect(pinnedRange("0.4.0-beta.1")).toBe("0.4.0-beta.1");
  });

  it("does not invent a range for an unrecognized development version", () => {
    expect(pinnedRange("dev")).toBe("dev");
  });
});
