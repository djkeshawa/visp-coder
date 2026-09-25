import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderSettings, requestedSettings } from "../../config/effective.js";
import { PRODUCT_NAME } from "../../core/constants.js";
import { ok } from "../../core/result.js";
import { withRuntimeDiagnostic } from "../../core/runtime-agreement.js";
import { runtimeIdentity } from "../../core/version.js";
import { runChecks } from "../../doctor/checks.js";
import { readCurrentLineage } from "../../skills/lineage.js";
import { readIndex, readSkillBody } from "../../skills/store.js";
import { TOOL } from "../constants.js";
import { workspaceFor } from "../context.js";
import { failure, reply } from "../reply.js";

/**
 * Two things an agent could previously only get by shelling out: why a refusal
 * is happening, and what the task it is about to start actually asks for.
 *
 * Both are read-only. Changing the policy, or recording an exception to it,
 * stays a human decision at the CLI — an agent that can widen the rules it is
 * being held to is not being held to them.
 */
export function registerDiagnoseTools(server: McpServer, root: string): void {
  server.registerTool(
    TOOL.doctor,
    {
      title: "Check the setup",
      description:
        "Report whether this project is set up correctly and what is enforcing scope. " +
        "Call this when a command fails in a way that looks like a broken install.",
      inputSchema: {
        settings: z
          .boolean()
          .optional()
          .describe("Explain effective settings without changing them"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const state = await workspaceFor(root);
      if (!state.ok) return failure(TOOL.doctor, withRuntimeDiagnostic(state.error));

      const report = await runChecks(state.value);
      const settings = await requestedSettings(state.value, args.settings);

      return reply(TOOL.doctor, ok({ runtime: runtimeIdentity(), ...report, ...settings }), {
        text: (data) =>
          [
            `${PRODUCT_NAME} is ${data.verdict}.`,
            ...renderSettings(settings.settings),
            `Runtime: ${data.runtime.version} build ${data.runtime.buildId} (${data.runtime.executable})`,
            ...data.checks.map(
              (check) =>
                `  ${check.status.padEnd(7)} ${check.name}: ${check.detail}` +
                (check.recovery ? ` (fix: ${check.recovery})` : ""),
            ),
          ].join("\n"),
      });
    },
  );
}

/**
 * Skills are readable here and nothing more. Proposing one writes to the
 * project; admitting one decides what future work is told to do. Both belong
 * at the CLI, where a person is the one doing it.
 */
export function registerSkillTools(server: McpServer, root: string): void {
  server.registerTool(
    TOOL.skillList,
    {
      title: "List this project's skills",
      description: "Skills the project has learned, and where each one stands.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const state = await workspaceFor(root);
      if (!state.ok) return failure(TOOL.skillList, state.error);

      const skills = await readCurrentLineage(state.value);
      if (!skills.ok) return failure(TOOL.skillList, skills.error);

      return reply(TOOL.skillList, ok({ skills: skills.value }), {
        text: (data) =>
          data.skills.length === 0
            ? "No skills yet."
            : data.skills
                .map((skill) => `${skill.state} ${skill.trust} ${skill.id}: ${skill.description}`)
                .join("\n"),
      });
    },
  );

  server.registerTool(
    TOOL.skillShow,
    {
      title: "Read one skill",
      description: "The body of a skill, with what it was drawn from and who admitted it.",
      inputSchema: { id: z.string().describe("Skill id, from visp_skill_list") },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const state = await workspaceFor(root);
      if (!state.ok) return failure(TOOL.skillShow, state.error);

      const index = await readIndex(state.value);
      if (!index.ok) return failure(TOOL.skillShow, index.error);

      const record = index.value.skills.find((skill) => skill.id === args.id);
      if (!record) {
        return failure(TOOL.skillShow, {
          code: "ARTIFACT_MISSING",
          message: `No skill named ${args.id}`,
          recovery: `${PRODUCT_NAME} skill list`,
        });
      }

      const body = await readSkillBody(state.value, args.id);

      return reply(TOOL.skillShow, ok({ ...record, body: body.ok ? (body.value ?? "") : "" }), {
        text: (data) => data.body,
      });
    },
  );
}
