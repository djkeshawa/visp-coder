import { describe, expect, it } from "vitest";
import { canonicalJson, hashValue, sha256 } from "../../../src/core/hash.js";

describe("canonicalJson", () => {
  it("sorts object keys so key order cannot change the output", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omits undefined members", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("passes primitives through", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("text")).toBe('"text"');
    expect(canonicalJson(42)).toBe("42");
  });
});

describe("hashValue", () => {
  it("is stable across equal values written differently", () => {
    expect(hashValue({ a: 1, b: [1, 2] })).toBe(hashValue({ b: [1, 2], a: 1 }));
  });

  it("changes when content changes", () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it("produces a 64-character hex digest", () => {
    expect(hashValue({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sha256", () => {
  it("hashes a known value", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("shortens a hash for display", () => {});
});
