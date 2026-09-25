import { describe, expect, it } from "vitest";
import { isExecutableMode } from "../../../src/core/mode.js";

describe("isExecutableMode", () => {
  it("requires an execute bit on POSIX", () => {
    expect(isExecutableMode(0o100644, "linux")).toBe(false);
    expect(isExecutableMode(0o100755, "linux")).toBe(true);
  });

  it("uses content and handshake verification instead of unavailable mode bits on Windows", () => {
    expect(isExecutableMode(0o100666, "win32")).toBe(true);
    expect(isExecutableMode(undefined, "win32")).toBe(false);
  });
});
