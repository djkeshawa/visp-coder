import { execFileSync } from "node:child_process";
import { readFile, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCommandInput, readStandardInput } from "../../../src/cli/input.js";
import {
  applyFileTransaction,
  inspectFileTransactions,
} from "../../../src/core/file-transaction.js";
import { ok } from "../../../src/core/result.js";
import { productInputTemplate } from "../../../src/workflow/product-inputs.js";
import { productWorkspace } from "../support/product-workspace.js";
import type { TestWorkspace } from "../support/workspace.js";
import { runCli, runJson } from "./support/cli.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.destroy()));
});

describe("bounded product input", () => {
  it("reads split UTF-8 input without creating a draft file", async () => {
    const { workspace } = await productWorkspace();
    workspaces.push(workspace);
    const bytes = Buffer.from('reason: "Review café"');
    const source = Readable.from([bytes.subarray(0, bytes.length - 2), bytes.subarray(-2)]);
    expect(await readCommandInput(await workspace.state(), "-", source)).toEqual({
      reason: "Review café",
    });
    expect(workspace.git("status", "--porcelain")).not.toContain("draft");
  });

  it("bounds bytes, rejects empty input, and propagates stream errors", async () => {
    await expect(readStandardInput(Readable.from([Buffer.alloc(1024 * 1024 + 1)]))).rejects.toThrow(
      "1 MiB",
    );
    await expect(readStandardInput(Readable.from([]))).rejects.toThrow("empty");
    const broken = new Readable({
      read() {
        this.destroy(new Error("broken input"));
      },
    });
    await expect(readStandardInput(broken)).rejects.toThrow("broken input");
  });

  it("refuses a terminal and stops waiting for an unfinished pipe", async () => {
    const terminal = Object.assign(Readable.from([]), { isTTY: true });
    await expect(readStandardInput(terminal)).rejects.toThrow("Pipe");
    const unfinished = new Readable({ read() {} });
    await expect(readStandardInput(unfinished, 10)).rejects.toThrow("timed out");
    unfinished.destroy();
    const closed = new Readable({
      read() {
        this.destroy();
      },
    });
    await expect(readStandardInput(closed)).rejects.toThrow("closed before completion");
  });

  it("applies the same YAML boundary to files and stdin", async () => {
    const { workspace } = await productWorkspace();
    workspaces.push(workspace);
    const state = await workspace.state();
    await workspace.write(".visp/input.yaml", "value: [\n");
    await expect(readCommandInput(state, ".visp/input.yaml")).rejects.toThrow();
    await expect(readCommandInput(state, "-", Readable.from(["value: [\n"]))).rejects.toThrow();
    await expect(readCommandInput(state, "../outside.yaml")).rejects.toThrow();
  });

  it("bounds file size before reading and retains the limit if a file grows", async () => {
    const { workspace } = await productWorkspace();
    workspaces.push(workspace);
    const state = await workspace.state();
    await workspace.write(".visp/input.yaml", Buffer.alloc(1024 * 1024 + 1));
    const read = vi.spyOn(state.files, "readBytes");
    await expect(readCommandInput(state, ".visp/input.yaml")).rejects.toThrow("1 MiB");
    expect(read).not.toHaveBeenCalled();
    await workspace.write(".visp/input.yaml", "answer: 42\n");
    expect(await readCommandInput(state, ".visp/input.yaml")).toEqual({ answer: 42 });
    read.mockResolvedValueOnce(ok(Buffer.alloc(1024 * 1024 + 1)));
    await expect(readCommandInput(state, ".visp/input.yaml")).rejects.toThrow("1 MiB");
  });

  it("refuses directories, missing inputs and escaping symlinks before reading", async () => {
    const { workspace } = await productWorkspace();
    workspaces.push(workspace);
    const state = await workspace.state();
    const read = vi.spyOn(state.files, "readBytes");
    await expect(readCommandInput(state, ".visp")).rejects.toThrow("regular file");
    await expect(readCommandInput(state, ".visp/missing.yaml")).rejects.toThrow("not found");
    await symlink("../../outside.yaml", join(workspace.root, ".visp/input.yaml"));
    await expect(readCommandInput(state, ".visp/input.yaml")).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("refuses named pipes without opening them", async () => {
    const { workspace } = await productWorkspace();
    workspaces.push(workspace);
    const state = await workspace.state();
    execFileSync("mkfifo", [join(workspace.root, ".visp/input.yaml")]);
    const read = vi.spyOn(state.files, "readBytes").mockImplementation(async () => {
      throw new Error("Opening this pipe would wait indefinitely for a writer");
    });
    await expect(readCommandInput(state, ".visp/input.yaml")).rejects.toThrow("regular file");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("editable product templates", () => {
  it("shows brief field examples without requiring a configured project", async () => {
    const result = await runCli("/nonexistent-visp-help-project", "brief", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"statement": "The requested behavior is observable"');
    expect(result.stdout).toContain('"scope"');
    expect(result.stdout).toContain("--from - --reason");
    expect(result.stderr).toBe("");
  });

  it.each(["brief", "review"] as const)(
    "recovers interrupted configuration before loading a %s submission, while templates remain read-only",
    async (operation) => {
      const { workspace, brief } = await productWorkspace();
      workspaces.push(workspace);
      const state = await workspace.state();
      const template = await productInputTemplate(state, operation);
      if (!template.ok) throw new Error(template.error.message);
      await workspace.write(".visp/transient-input.json", JSON.stringify(template.value));
      const config = await readFile(join(workspace.root, "visp.yml"), "utf8");
      const interrupted = await applyFileTransaction(
        workspace.root,
        "interrupted configuration",
        [{ kind: "write", path: "visp.yml", content: "broken: [\n" }],
        {
          leavePreparedOnError: true,
          afterMutation() {
            throw new Error("Simulated interruption");
          },
        },
      );
      expect(interrupted.ok).toBe(false);
      const readonly = await runJson(workspace.root, operation, "--template");
      expect(readonly.envelope.error?.code).toBe("CONFIG_INVALID");
      const pending = await inspectFileTransactions(workspace.root);
      expect(pending.ok && pending.value.pending).toHaveLength(1);
      expect(await readFile(join(workspace.root, "visp.yml"), "utf8")).toBe("broken: [\n");
      const submitted = await runJson(
        workspace.root,
        operation,
        "--feature",
        brief.feature,
        "--from",
        ".visp/transient-input.json",
        ...(operation === "brief" ? ["--reason", "Keep the intended behavior"] : []),
      );
      expect(submitted.exitCode, JSON.stringify(submitted.envelope)).toBe(0);
      expect(await readFile(join(workspace.root, "visp.yml"), "utf8")).toBe(config);
      const recovered = await inspectFileTransactions(workspace.root);
      expect(recovered.ok && recovered.value.pending).toEqual([]);
    },
  );

  it.each(["brief", "review"])(
    "does not silently turn an empty %s input path into a read",
    async (operation) => {
      const { workspace } = await productWorkspace();
      workspaces.push(workspace);
      const result = await runJson(workspace.root, operation, "--from", "");
      expect(result.envelope.error?.code).toBe("ARTIFACT_INVALID");
    },
  );
  it("returns plain editable input and preserves state bytes", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const path = `.visp/features/${brief.feature}/product-state.json`;
    const state = await workspace.state();
    const before = await state.files.readText(path);
    const editable = await runCli(workspace.root, "brief", "--template");
    expect(editable.exitCode, editable.stderr).toBe(0);
    expect(JSON.parse(editable.stdout)).toEqual(brief);
    const review = await runJson<{ assessments: { status: string }[]; subjectDigest: string }>(
      workspace.root,
      "review",
      "--template",
    );
    expect(review.envelope.data?.subjectDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(review.envelope.data?.assessments.every((row) => row.status === "unclear")).toBe(true);
    expect(await state.files.readText(path)).toEqual(before);
    const invalid = await runJson(workspace.root, "review", "--template", "--from", "-");
    expect(invalid.envelope.error?.code).toBe("ARTIFACT_INVALID");
  });

  it("recovers session input errors from the prepared packet rather than the legacy template", async () => {
    const { workspace } = await productWorkspace();
    workspaces.push(workspace);
    const prepared = await runJson<{ session: string; responsePath: string }>(
      workspace.root,
      "review",
      "--prepare",
      "--task",
      "T001",
    );
    const session = prepared.envelope.data;
    if (!session) throw new Error("No session");
    await workspace.write(
      relative(workspace.root, session.responsePath),
      JSON.stringify({ subjectDigest: "legacy", assessments: [] }),
    );
    const rejected = await runJson(
      workspace.root,
      "review",
      "--session",
      session.session,
      "--from",
      session.responsePath,
    );
    expect(rejected.envelope.error).toMatchObject({
      code: "ARTIFACT_INVALID",
      message: expect.stringContaining("omit subjectDigest, selection and captures"),
      recovery: expect.stringContaining("this session's packet.json"),
    });
    expect(rejected.envelope.error?.recovery).not.toContain("visp review --template");
  });

  it("shows a concise status while JSON retains complete state", async () => {
    const { workspace } = await productWorkspace();
    workspaces.push(workspace);
    const text = await runCli(workspace.root, "status");
    const json = await runJson(workspace.root, "status");
    expect(text.stdout).toContain("## Next");
    expect(text.stdout).not.toContain('"executions"');
    expect(text.stdout.length).toBeLessThan(json.stdout.length / 2);
    expect(json.envelope.data).toHaveProperty("state");
  });
});
