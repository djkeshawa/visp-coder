import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_CONFIG_FILE,
  inspectMcpRegistrationResidue,
  MCP_CONFIG_FILE,
  MCP_SERVER_NAME,
  mcpConfigFile,
  OPENCODE_CONFIG_FILE,
  planMcpUnregistration,
  registerMcpServer,
} from "../../../src/harness/mcp-registration.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-mcp-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readConfig(
  file = MCP_CONFIG_FILE,
): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(join(root, file), "utf8"));
}

const REGISTRATIONS = [
  { harness: "claude-code" as const, file: MCP_CONFIG_FILE, container: "mcpServers" },
  { harness: "opencode" as const, file: OPENCODE_CONFIG_FILE, container: "mcp" },
] as const;

describe("registerMcpServer", () => {
  it("creates the file when none exists", async () => {
    const result = await registerMcpServer(root, false);
    expect(result.ok && result.value).toBe("added");

    const config = await readConfig();
    expect(config.mcpServers?.[MCP_SERVER_NAME]).toEqual({
      command: "visp",
      args: ["serve", "--mcp"],
    });
  });

  it("keeps servers the project already configured", async () => {
    await writeFile(
      join(root, MCP_CONFIG_FILE),
      JSON.stringify({ mcpServers: { other: { command: "other-tool" } } }),
    );

    await registerMcpServer(root, false);

    const config = await readConfig();
    expect(config.mcpServers?.other).toEqual({ command: "other-tool" });
    expect(config.mcpServers?.[MCP_SERVER_NAME]).toBeDefined();
  });

  it("preserves unrelated top-level keys", async () => {
    await writeFile(join(root, MCP_CONFIG_FILE), JSON.stringify({ somethingElse: 42 }));

    await registerMcpServer(root, false);

    const config = await readConfig();
    expect(config.somethingElse).toBe(42);
  });

  it("reports an unchanged registration as current", async () => {
    await registerMcpServer(root, false);
    const second = await registerMcpServer(root, false);
    expect(second.ok && second.value).toBe("current");
  });

  it("leaves a customised visp entry alone unless forced", async () => {
    await writeFile(
      join(root, MCP_CONFIG_FILE),
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: "/custom/visp" } } }),
    );

    const result = await registerMcpServer(root, false);
    expect(result.ok && result.value).toBe("customized");

    const config = await readConfig();
    expect(config.mcpServers?.[MCP_SERVER_NAME]).toEqual({ command: "/custom/visp" });
  });

  it("replaces a customised entry when forced", async () => {
    await writeFile(
      join(root, MCP_CONFIG_FILE),
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: "/custom/visp" } } }),
    );

    const result = await registerMcpServer(root, true);
    expect(result.ok && result.value).toBe("replaced");
  });

  /** Overwriting a file we cannot parse would discard whatever it holds. */
  it("refuses to rewrite a malformed config", async () => {
    await writeFile(join(root, MCP_CONFIG_FILE), "{ not json");

    const result = await registerMcpServer(root, false);
    expect(result.ok && result.value).toBe("malformed");
    expect(await readFile(join(root, MCP_CONFIG_FILE), "utf8")).toBe("{ not json");
  });

  it("replaces a malformed config only when forced", async () => {
    await writeFile(join(root, MCP_CONFIG_FILE), "{ not json");

    const result = await registerMcpServer(root, true);
    expect(result.ok && result.value).toBe("replaced");
    expect((await readConfig()).mcpServers?.[MCP_SERVER_NAME]).toBeDefined();
  });

  it("treats an empty file as no configuration", async () => {
    await writeFile(join(root, MCP_CONFIG_FILE), "   ");

    const result = await registerMcpServer(root, false);
    expect(result.ok && result.value).toBe("added");
  });
});

describe("OpenCode MCP registration", () => {
  it("uses the project OpenCode configuration and current local-server shape", async () => {
    const result = await registerMcpServer(root, false, "opencode");
    expect(result.ok && result.value).toBe("added");
    expect(mcpConfigFile("opencode")).toBe(OPENCODE_CONFIG_FILE);

    const config = await readConfig(OPENCODE_CONFIG_FILE);
    expect(config.mcp?.[MCP_SERVER_NAME]).toEqual({
      type: "local",
      command: ["visp", "serve", "--mcp"],
    });
    await expect(readFile(join(root, MCP_CONFIG_FILE), "utf8")).rejects.toThrow();
  });

  it("preserves unrelated OpenCode settings and MCP servers", async () => {
    await writeFile(
      join(root, OPENCODE_CONFIG_FILE),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "openrouter/stealth/ox-alpha",
        mcp: { other: { type: "remote", url: "https://example.test/mcp" } },
      }),
    );

    await registerMcpServer(root, false, "opencode");

    const config = await readConfig(OPENCODE_CONFIG_FILE);
    expect(config.model).toBe("openrouter/stealth/ox-alpha");
    expect(config.mcp?.other).toEqual({ type: "remote", url: "https://example.test/mcp" });
    expect(config.mcp?.[MCP_SERVER_NAME]).toBeDefined();
  });

  it("keeps a customized OpenCode visp entry unless forced", async () => {
    const custom = { type: "local", command: ["/custom/visp", "serve", "--mcp"] };
    await writeFile(
      join(root, OPENCODE_CONFIG_FILE),
      JSON.stringify({ mcp: { [MCP_SERVER_NAME]: custom } }),
    );

    const kept = await registerMcpServer(root, false, "opencode");
    expect(kept.ok && kept.value).toBe("customized");
    expect((await readConfig(OPENCODE_CONFIG_FILE)).mcp?.[MCP_SERVER_NAME]).toEqual(custom);

    const replaced = await registerMcpServer(root, true, "opencode");
    expect(replaced.ok && replaced.value).toBe("replaced");
    expect((await readConfig(OPENCODE_CONFIG_FILE)).mcp?.[MCP_SERVER_NAME]).not.toEqual(custom);
  });

  it("does not overwrite malformed OpenCode configuration without force", async () => {
    await writeFile(join(root, OPENCODE_CONFIG_FILE), "{ commented: nope");

    const result = await registerMcpServer(root, false, "opencode");
    expect(result.ok && result.value).toBe("malformed");
    expect(await readFile(join(root, OPENCODE_CONFIG_FILE), "utf8")).toBe("{ commented: nope");
  });

  it("replaces malformed OpenCode configuration only when forced", async () => {
    await writeFile(join(root, OPENCODE_CONFIG_FILE), "{ commented: nope");

    const result = await registerMcpServer(root, true, "opencode");
    expect(result.ok && result.value).toBe("replaced");
    expect((await readConfig(OPENCODE_CONFIG_FILE)).mcp?.[MCP_SERVER_NAME]).toBeDefined();
  });
});

describe("Codex MCP registration", () => {
  beforeEach(async () => {
    await mkdir(join(root, ".codex"), { recursive: true });
  });

  it("writes the trusted project config instead of the plugin manifest", async () => {
    const result = await registerMcpServer(root, false, "codex");

    expect(result.ok && result.value).toBe("added");
    expect(mcpConfigFile("codex")).toBe(CODEX_CONFIG_FILE);
    expect(await readFile(join(root, CODEX_CONFIG_FILE), "utf8")).toContain("[mcp_servers.visp]");
    await expect(readFile(join(root, MCP_CONFIG_FILE), "utf8")).rejects.toThrow();
  });

  it("preserves and refuses existing Codex settings and servers", async () => {
    const current = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n`;
    await writeFile(join(root, CODEX_CONFIG_FILE), current, "utf8");

    const result = await registerMcpServer(root, false, "codex");

    expect(result.ok && result.value).toBe("malformed");
    expect(await readFile(join(root, CODEX_CONFIG_FILE), "utf8")).toBe(current);
  });

  it("leaves a customized Codex entry alone unless forced", async () => {
    const current = `[mcp_servers.visp]\ncommand = "/custom/visp"\nargs = ["serve", "--mcp"]\n`;
    await writeFile(join(root, CODEX_CONFIG_FILE), current, "utf8");

    const result = await registerMcpServer(root, false, "codex");

    expect(result.ok && result.value).toBe("customized");
    expect(await readFile(join(root, CODEX_CONFIG_FILE), "utf8")).toBe(current);
  });

  it("preserves a customized Codex entry even when forced", async () => {
    const current = `model = "gpt-5"\n\n[mcp_servers.visp]\ncommand = "/custom/visp"\n\n[mcp_servers.other]\ncommand = "other"\n`;
    await writeFile(join(root, CODEX_CONFIG_FILE), current, "utf8");

    const result = await registerMcpServer(root, true, "codex");

    expect(result.ok && result.value).toBe("customized");
    expect(await readFile(join(root, CODEX_CONFIG_FILE), "utf8")).toBe(current);
  });

  it("refuses an ambiguous inline mcp_servers table without changing it", async () => {
    const current = 'mcp_servers = { other = { command = "other" } }\n';
    await writeFile(join(root, CODEX_CONFIG_FILE), current, "utf8");

    const result = await registerMcpServer(root, false, "codex");

    expect(result.ok && result.value).toBe("malformed");
    expect(await readFile(join(root, CODEX_CONFIG_FILE), "utf8")).toBe(current);
  });

  it.each([
    '[mcp_servers."visp"]\ncommand = "/custom/visp"\n',
    '[mcp_servers.visp]\ncommand = "/custom/visp"\n\n[mcp_servers.visp.env]\nTOKEN = "set"\n',
    'note = """[mcp_servers.visp]\ncommand = \\"hidden\\"""\n',
  ])("refuses ambiguous Codex TOML without forceful rewriting: %s", async (current) => {
    await writeFile(join(root, CODEX_CONFIG_FILE), current, "utf8");

    const result = await registerMcpServer(root, true, "codex");

    expect(result.ok && result.value).toBe("customized");
    expect(await readFile(join(root, CODEX_CONFIG_FILE), "utf8")).toBe(current);
  });
});

describe.each(REGISTRATIONS)(
  "unsafe $harness MCP configuration shapes",
  ({ harness, file, container }) => {
    it.each([
      ["a scalar root", '"not an object"'],
      ["an array root", '["not an object"]'],
    ])("reports %s without writing", async (_description, content) => {
      await writeFile(join(root, file), content);

      const result = await registerMcpServer(root, false, harness);

      expect(result.ok && result.value).toBe("malformed");
      expect(await readFile(join(root, file), "utf8")).toBe(content);
    });

    it.each([
      ["a scalar container", '"not an object"'],
      ["an array container", '["not an object"]'],
    ])("reports %s without writing", async (_description, invalidContainer) => {
      const content = JSON.stringify({
        projectSetting: "keep me",
        [container]: JSON.parse(invalidContainer),
      });
      await writeFile(join(root, file), content);

      const result = await registerMcpServer(root, false, harness);

      expect(result.ok && result.value).toBe("malformed");
      expect(await readFile(join(root, file), "utf8")).toBe(content);
    });

    it.each([
      ["a scalar root", '"not an object"'],
      ["an array root", '["not an object"]'],
    ])("replaces %s only when forced", async (_description, content) => {
      await writeFile(join(root, file), content);

      const result = await registerMcpServer(root, true, harness);

      expect(result.ok && result.value).toBe("replaced");
      const config = JSON.parse(await readFile(join(root, file), "utf8")) as Record<
        string,
        unknown
      >;
      expect(config[container]).toEqual({
        [MCP_SERVER_NAME]: expect.any(Object),
      });
    });

    it.each([
      ["a scalar container", '"not an object"'],
      ["an array container", '["not an object"]'],
    ])(
      "replaces %s only when forced and preserves top-level settings",
      async (_description, invalidContainer) => {
        const content = JSON.stringify({
          projectSetting: "keep me",
          [container]: JSON.parse(invalidContainer),
        });
        await writeFile(join(root, file), content);

        const result = await registerMcpServer(root, true, harness);

        expect(result.ok && result.value).toBe("replaced");
        const config = JSON.parse(await readFile(join(root, file), "utf8")) as Record<
          string,
          unknown
        >;
        expect(config.projectSetting).toBe("keep me");
        expect(config[container]).toEqual({
          [MCP_SERVER_NAME]: expect.any(Object),
        });
      },
    );
  },
);

describe.each(REGISTRATIONS)(
  "$harness MCP registration cleanup",
  ({ harness, file, container }) => {
    it("removes only the exact generated VISP entry", async () => {
      await registerMcpServer(root, false, harness);
      const config = await readConfig(file);
      config.projectSetting = { keep: true };
      const servers = config[container];
      if (!servers) throw new Error("missing generated MCP container");
      servers.other = { command: "other-tool" };
      const current = `${JSON.stringify(config, null, 2)}\n`;

      const planned = planMcpUnregistration(current, harness);

      expect(planned.status).toBe("removed");
      const cleaned = JSON.parse(planned.content ?? "") as Record<string, Record<string, unknown>>;
      expect(cleaned.projectSetting).toEqual({ keep: true });
      expect(cleaned[container]?.other).toEqual({ command: "other-tool" });
      expect(cleaned[container]?.[MCP_SERVER_NAME]).toBeUndefined();
    });

    it("classifies a customized entry for manual review and leaves it unchanged", () => {
      const current = JSON.stringify({ [container]: { [MCP_SERVER_NAME]: { custom: true } } });

      expect(inspectMcpRegistrationResidue(current, harness)).toEqual({
        exact: false,
        customized: true,
        malformed: false,
      });
      expect(planMcpUnregistration(current, harness)).toEqual({ status: "customized" });
    });

    it("only flags malformed text when it identifies a VISP server entry", () => {
      expect(inspectMcpRegistrationResidue('{"visp":', harness)).toEqual({
        exact: false,
        customized: false,
        malformed: true,
      });
      expect(inspectMcpRegistrationResidue("{not-json", harness)).toEqual({
        exact: false,
        customized: false,
        malformed: false,
      });
    });
  },
);
