import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ResourceProject, startResourceProject } from "./resource-fixture.js";

/**
 * A resource that cannot answer must say so. An agent treats a successful read
 * as the truth about the project, so an absent artifact has to arrive as a
 * failure rather than as an empty-looking document.
 */
describe("reads that cannot be answered", () => {
  let project: ResourceProject;

  beforeAll(async () => {
    project = await startResourceProject("visp-mcp-missing-resources-");
  });

  afterAll(async () => {
    await project.close();
  });

  it("fails rather than returning an empty brief for a feature that does not exist", async () => {
    const error = await failedRead(project, "visp://feature/404-no-such-feature/brief");

    // Resources refuse by throwing, and the throw loses visp's own error
    // code: every refusal arrives as a generic protocol-level failure, so
    // the cause is only readable from the message.
    expect(error.code).toBe(ErrorCode.InternalError);
    expect(error.message).toContain("404-no-such-feature");
  });

  /**
   * An id out of a uri becomes a path segment, and on a platform where a
   * backslash separates paths a segment like `..\..\x` would leave `.visp/`
   * entirely. The id is refused on its shape, before any file is read.
   */
  for (const [uri, expected] of [
    ["visp://feature/not-a-feature-id/brief", '"not-a-feature-id" is not a feature id'],
    ["visp://feature/..\\..\\elsewhere/brief", "is not a feature id"],
  ] as const) {
    it(`refuses ${uri} without looking for a file`, async () => {
      const error = await failedRead(project, uri);

      expect(error.message).toContain(expected);
      expect(error.message).not.toContain(project.root);
      expect(error.message).not.toMatch(/file not found/i);
    });
  }

  /**
   * The handler pulls the feature id out of the expanded uri and falls back to
   * an empty string when it is absent, which would silently become a lookup for
   * the feature named "". These pin the reason that fallback never fires: the
   * sdk expands `{id}` to a pattern that matches neither an empty segment nor
   * one containing a slash, so a uri shaped like these is refused as an unknown
   * resource before the handler is called at all.
   */
  for (const uri of ["visp://feature//brief", "visp://feature/a/b/brief", "visp://feature/brief"]) {
    it(`rejects ${uri} as an unknown resource instead of looking one up`, async () => {
      const error = await failedRead(project, uri);

      expect(error.code).toBe(ErrorCode.InvalidParams);
      expect(error.message).toMatch(/not found/i);
      expect(error.message).not.toContain(project.root);
    });
  }
});

/** Reads a resource that is expected to fail, and returns the protocol error. */
async function failedRead(project: ResourceProject, uri: string): Promise<McpError> {
  try {
    const read = await project.read(uri);
    throw new Error(`${uri} unexpectedly succeeded: ${JSON.stringify(read.value)}`);
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
}
