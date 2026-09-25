import { describe, expect, it } from "vitest";
import { inlineJavaScript } from "../../../../src/graph/extract/html-scripts.js";
import { indexFixture, makeRepo } from "../fixtures.js";

describe("inline page intelligence", () => {
  it("finds real handlers after long CSS with original line numbers and call edges", async () => {
    const source = `<style>\n${".x {color:red}\n".repeat(700)}</style>\n<script>\nfunction reset() { return 0; }\nfunction start() { return reset(); }\nstart();\n</script>`;
    const repo = await makeRepo({ "index.html": source });
    try {
      const snapshot = await indexFixture(repo);
      expect(snapshot.entities).toContainEqual(
        expect.objectContaining({ path: "index.html", name: "reset", startLine: 704 }),
      );
      expect(snapshot.relations).toContainEqual(
        expect.objectContaining({
          kind: "calls",
          source: "index.html#function:start",
          target: "index.html#function:reset",
          line: 705,
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it("ignores inert markup, quoted tag lookalikes, data scripts and external script bodies", () => {
    const source = `<!-- <script>bad()</script> --><style>"<script>bad()</script>"</style><textarea><script>bad()</script></textarea><template><template></template><script>bad()</script></template><div title="<script>bad()">text</div><script type="application/json">bad()</script><script src=x.js>bad()</script><SCRIPT data-label=">">good()</SCRIPT>`;
    const parsed = inlineJavaScript(source);
    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.source).toContain("good()");
    expect(parsed.source).not.toContain("bad()");
    expect(parsed.source.length).toBe(source.length);
  });

  it("keeps relative imports but withholds speculative cross-module calls", async () => {
    const repo = await makeRepo({
      "index.html":
        '<script type="module">import { value } from "./value.js"; function same(){return value}</script>\n<script type="module">function same(){} same()</script>',
      "value.js": "export const value = 1;",
    });
    try {
      const snapshot = await indexFixture(repo);
      expect(snapshot.relations).toContainEqual(
        expect.objectContaining({ kind: "imports", target: "value.js#file" }),
      );
      expect(snapshot.entities.filter((entity) => entity.name === "same")).toHaveLength(2);
      expect(
        snapshot.relations.filter(
          (relation) => relation.path === "index.html" && relation.kind === "calls",
        ),
      ).toEqual([]);
      expect(snapshot.unknowns.some((entry) => entry.detail?.includes("Multiple inline"))).toBe(
        true,
      );
    } finally {
      await repo.cleanup();
    }
  });
});
