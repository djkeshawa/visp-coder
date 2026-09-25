import { describe, expect, it } from "vitest";
import { browserKey, browserKeySchema } from "../../../src/testing/browser-keys.js";

describe("promised keyboard journeys", () => {
  it.each(["r", "R", "0", "9", "Space", "Enter", "ArrowLeft"])(
    "maps %s to native browser key events",
    (key) => {
      expect(browserKeySchema.safeParse(key).success).toBe(true);
      expect(browserKey(key).windowsVirtualKeyCode).toBeGreaterThan(0);
    },
  );
  it("preserves letter case and physical codes", () => {
    expect(browserKey("r")).toMatchObject({
      key: "r",
      code: "KeyR",
      text: "r",
      windowsVirtualKeyCode: 82,
    });
    expect(browserKey("R")).toMatchObject({ key: "R", code: "KeyR", modifiers: 8 });
    expect(browserKey("7")).toMatchObject({ code: "Digit7", text: "7" });
    expect(browserKey("Tab").text).toBeUndefined();
  });
  it.each(["", "Control+r", "toString", "é", "Delete"])("rejects unsupported key %j", (key) => {
    expect(() => browserKey(key)).toThrow("Unsupported browser key");
  });
});
