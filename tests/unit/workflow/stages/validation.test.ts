import { describe, expect, it } from "vitest";
import { nextFeatureId, slugify } from "../../../../src/workflow/product/feature-id.js";

describe("slugify", () => {
  it("makes a short kebab slug from a goal", () => {
    expect(slugify("Add user login")).toBe("add-user-login");
  });

  it("drops punctuation and collapses separators", () => {
    expect(slugify("Fix: the (broken) parser!")).toBe("fix-the-broken-parser");
  });

  it("keeps at most five words", () => {
    expect(slugify("one two three four five six seven")).toBe("one-two-three-four-five");
  });

  it("falls back to a usable slug when nothing survives", () => {
    expect(slugify("!!!")).toBe("feature");
  });
});

describe("nextFeatureId", () => {
  it("starts at 001", () => {
    expect(nextFeatureId([], "Add login")).toBe("001-add-login");
  });

  it("continues from the highest existing ordinal", () => {
    expect(nextFeatureId(["002-b", "001-a"], "Add login")).toBe("003-add-login");
  });

  it("ignores directories that are not feature ids", () => {
    expect(nextFeatureId(["notafeature", "001-a"], "Add login")).toBe("002-add-login");
  });
});
