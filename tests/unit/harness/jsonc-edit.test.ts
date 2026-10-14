import { describe, expect, it } from "vitest";
import { removeJsoncMember, setJsoncMember } from "../../../src/harness/jsonc-edit.js";

/** JSONC as the hosts read it: comments and trailing commas removed. */
function read(text: string): unknown {
  const plain = text
    .replace(/"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (match) =>
      match.startsWith('"') ? match : "",
    )
    .replace(/,(\s*[}\]])/gu, "$1");
  return JSON.parse(plain);
}

describe("setJsoncMember", () => {
  it("expands an empty object", () => {
    expect(setJsoncMember('{ "servers": {} }\n', ["servers", "visp"], { a: 1 })).toBe(
      '{ "servers": {"visp": {"a":1}} }\n',
    );
    expect(setJsoncMember('{\n  "servers": {}\n}\n', ["servers", "visp"], { a: 1 })).toBe(
      '{\n  "servers": {\n    "visp": {\n      "a": 1\n    }\n  }\n}\n',
    );
  });

  it("keeps a comment inside an empty object", () => {
    const edited = setJsoncMember(
      '{\n  "servers": { /* none yet */ }\n}\n',
      ["servers", "visp"],
      1,
    );
    expect(edited).toBe('{\n  "servers": {\n    "visp": 1 /* none yet */ }\n}\n');
    expect(read(edited ?? "")).toEqual({ servers: { visp: 1 } });
  });

  it("is not misled by comment and brace characters inside strings", () => {
    const source = '{\n  "url": "http://x/{y}", // a // b\n  "note": "say \\"hi\\" /* not */"\n}\n';
    const edited = setJsoncMember(source, ["servers", "visp"], true);
    expect(edited).toBe(
      '{\n  "url": "http://x/{y}", // a // b\n  "note": "say \\"hi\\" /* not */",\n  "servers": {\n    "visp": true\n  }\n}\n',
    );
  });

  it("puts a closing brace that shared the last line on its own line", () => {
    const edited = setJsoncMember('{\n  "a": 1 }\n', ["b"], 2);
    expect(edited).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it("refuses a duplicated key and a path through a non-object", () => {
    expect(
      setJsoncMember('{"servers": {}, "servers": {}}', ["servers", "visp"], 1),
    ).toBeUndefined();
    expect(setJsoncMember('{"servers": []}', ["servers", "visp"], 1)).toBeUndefined();
    expect(setJsoncMember("[]", ["servers"], 1)).toBeUndefined();
    expect(setJsoncMember('{"a": 1 /* open', ["b"], 1)).toBeUndefined();
    expect(setJsoncMember('{"a": "open\n"}', ["b"], 1)).toBeUndefined();
  });
});

describe("removeJsoncMember", () => {
  it("removes a middle member with its comma and trailing comment", () => {
    const source = '{\n  "a": 1,\n  "visp": { "x": [1, 2] }, // ours\n  "b": 2\n}\n';
    expect(removeJsoncMember(source, ["visp"])).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it("removes the only member and leaves the text unchanged when it is absent", () => {
    expect(removeJsoncMember('{\r\n  "s": {\r\n    "visp": 1\r\n  }\r\n}\r\n', ["s", "visp"])).toBe(
      '{\r\n  "s": {\r\n  }\r\n}\r\n',
    );
    expect(removeJsoncMember('{"s": {"other": 1}}', ["s", "visp"])).toBe('{"s": {"other": 1}}');
    expect(removeJsoncMember('{"s": {"visp": 1, "b": 2}}', ["s", "visp"])).toBe('{"s": { "b": 2}}');
  });

  it.each([
    '{"servers":{"github":{"url":"x"}}}',
    '{\n\t"servers": {\n\t\t"github": {},\n\t},\n}\n',
    '// header\n{\n    /* a */ "inputs": [1, 2,],\n}\n',
    '{\n  "servers": {\n    "github": { "url": "x" } // hosted\n  }\n}\n',
  ])("round-trips set then remove on %j", (source) => {
    const added = setJsoncMember(source, ["servers", "visp"], { command: "node", args: ["a b"] });
    expect(read(added ?? "")).toEqual({
      ...(read(source) as object),
      servers: {
        ...((read(source) as { servers?: object }).servers ?? {}),
        visp: { command: "node", args: ["a b"] },
      },
    });
    const removed = removeJsoncMember(added ?? "", ["servers", "visp"]);
    expect(read(removed ?? "")).toEqual({
      servers: {},
      ...(read(source) as object),
    });
  });
});
