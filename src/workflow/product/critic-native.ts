import { join } from "node:path";
import type { z } from "zod";
import type { CriticConfig } from "../../config/critic.js";
import { vispError } from "../../core/errors.js";
import type { FileMutation } from "../../core/file-transaction.js";
import { sha256 } from "../../core/hash.js";
import { err, ok } from "../../core/result.js";
import type { CriticPacket } from "./critic.js";
import type { nativeCapabilitySchema } from "./critic-model.js";

type Capability = z.infer<typeof nativeCapabilitySchema>;

/** Describe delegation without inventing a provider endpoint or an authorization receipt. */
export function criticDelegation(config: CriticConfig, hasImages: boolean) {
  return {
    reviewer: {
      harness: config.harness,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    },
    provider: "host-configured; not resolved by VISP",
    payload: {
      projectEvidence: true,
      description:
        "Original request and selected project evidence, which may include source excerpts",
      images: hasImages,
    },
    authorization:
      "Use authorization already supplied for this destination and payload. If the host requires clarification, identify its actual provider, configured reviewer and selected project evidence/images before asking. This description does not establish consent or override a host refusal. Do not reserve while required authorization is unresolved.",
  };
}

/** Discovery only. Requested settings are not observed host capabilities. */
export function criticDispatchSetup(config: CriticConfig) {
  return {
    method: "native-handoff" as const,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    steps: [
      "Inspect the host's available delegation tools and restrictions; unreported capability is setup-needed, not a refusal.",
      "Pipe the actual capability JSON to critic --preflight --capabilities -; no setup file is needed.",
      "When ready, pipe the same report to critic --prepare --capabilities - for packetPath, responsePath and exact submission commands.",
      "Delegate one fresh reviewer with the configured model and effort, then submit its unchanged response.",
    ],
    capabilityInput: {
      preferred: "stdin" as const,
      option: "--capabilities -",
      fileAlternative: ".visp/critic-capabilities.json",
      guidance:
        "Keep transient host reports on stdin or under .visp/. Creating a report beside product source changes product identity and requires fresh evidence. Requested settings are not observed capabilities.",
    },
    codexCli:
      config.harness === "codex"
        ? {
            executable: "codex",
            mode: "exec --ephemeral --sandbox read-only",
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            requirements:
              "Check installed CLI support for --output-schema and host authorization before reserving. Filesystem read-only mode does not enforce restricted execution or skills. Use only where the host can honor the packet restrictions; never bypass a refusal.",
            paths:
              "prepare returns codexCli.args, stdinFile and the confined responsePath; no model starts during discovery.",
          }
        : undefined,
  };
}

export function nativeCapabilityGaps(
  config: CriticConfig,
  report: Capability | undefined,
  hasImages: boolean,
) {
  if (!report)
    return [
      "Report the host's available reviewer model, reasoning, fresh context, read-only delegation and image access before prepare; do not infer them from the worker model.",
    ];
  const gaps: string[] = [];
  if (report.delegationAllowed !== true)
    gaps.push(
      "Host delegation is unavailable, unreported or not authorized; establish it before reserving a call. Do not bypass a host refusal.",
    );
  if (config.transport !== "native")
    gaps.push(
      "This selection uses sampling; use review or configure native transport before its first attempt.",
    );
  if (config.harness !== report.harness)
    gaps.push("The reported host differs from the pinned critic harness.");
  if (config.model !== report.model)
    gaps.push("The requested critic model is unavailable; no automatic model substitution.");
  if (config.reasoningEffort && config.reasoningEffort !== report.reasoningEffort)
    gaps.push("The requested reasoning effort is unavailable or unconfirmed.");
  if (!report.freshContext) gaps.push("A fresh reviewer context is required.");
  if (!report.readOnly) gaps.push("The reviewer must have no source-editing or execution tools.");
  if (hasImages && !report.images)
    gaps.push(
      "The reviewer cannot inspect the supplied images; visual review remains unavailable.",
    );
  return gaps;
}

/** Machine-owned packet and image copies are committed with the attempt, never authored by the worker. */
export function nativePacket(packet: CriticPacket, directory: string, config: CriticConfig) {
  const mutations: FileMutation[] = [];
  const images: { path: string; sha256: string; mimeType: string }[] = [];
  let imageBytes = 0;
  const text = JSON.stringify(packet, (_key, value) => {
    if (
      value &&
      typeof value === "object" &&
      typeof value.data === "string" &&
      typeof value.mimeType === "string" &&
      value.mimeType.startsWith("image/")
    ) {
      const bytes = Buffer.from(value.data, "base64");
      const digest = sha256(bytes);
      const extension =
        value.mimeType === "image/jpeg" ? "jpg" : value.mimeType === "image/webp" ? "webp" : "png";
      const path = join(directory, `${digest}.${extension}`);
      if (!images.some((image) => image.path === path)) {
        imageBytes += bytes.byteLength;
        images.push({ path, sha256: digest, mimeType: value.mimeType });
        mutations.push({
          kind: "write",
          path,
          content: bytes,
          mode: 0o600,
          expectedBefore: { existed: false },
        });
      }
      const { data: _data, ...metadata } = value;
      return { ...metadata, imagePath: path };
    }
    return value;
  });
  if (imageBytes > config.maxImageBytes)
    return err(
      vispError(
        "STAGE_BLOCKED",
        "Native packet exceeds the configured image budget; no attempt reserved",
      ),
    );
  const schemaPath = join(directory, "response-schema.json");
  mutations.push({
    kind: "write",
    path: schemaPath,
    content: `${JSON.stringify(packet.responseSchema, null, 2)}\n`,
    mode: 0o600,
    expectedBefore: { existed: false },
  });
  const path = join(directory, "packet.json");
  mutations.push({
    kind: "write",
    path,
    content: text,
    mode: 0o600,
    expectedBefore: { existed: false },
  });
  const capabilitiesPath = join(directory, "capabilities.json");
  // Preflight describes available capabilities. It cannot report what a future invocation used.
  const observationTemplate = {
    harness: null,
    model: null,
    ...(config.reasoningEffort ? { reasoningEffort: null } : {}),
    freshContext: null,
    images: null,
    readOnly: null,
    delegationAllowed: null,
  };
  mutations.push({
    kind: "write",
    path: capabilitiesPath,
    content: `${JSON.stringify(observationTemplate, null, 2)}\n`,
    mode: 0o600,
    expectedBefore: { existed: false },
  });
  return ok({
    mutations,
    handoff: {
      delegation: {
        ...criticDelegation(config, images.length > 0),
        preparedPayload: {
          packetPath: path,
          packetBytes: Buffer.byteLength(text),
          imageCount: images.length,
          imageBytes,
        },
      },
      packetPath: path,
      responseSchemaPath: schemaPath,
      responsePath: join(directory, "response.json"),
      capabilitiesPath,
      capabilitiesStatus: "unobserved" as const,
      ...(config.harness === "codex"
        ? {
            codexCli: {
              executable: "codex",
              args: [
                "exec",
                "--ephemeral",
                "--sandbox",
                "read-only",
                "--model",
                config.model,
                ...(config.reasoningEffort
                  ? ["--config", `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`]
                  : []),
                ...images.flatMap((image) => ["--image", image.path]),
                "--output-schema",
                schemaPath,
                "--output-last-message",
                join(directory, "response.json"),
                "-",
              ],
              stdinFile: path,
              execution:
                "Fallback plan only; VISP does not launch it. Check CLI support and host authorization before prepare. Prefer a supported native reviewer with restricted tools. Read-only filesystem mode alone does not enforce no execution or no skills; use this fallback only when the host can honor the packet restrictions. Run once, foreground, cancel at expiresAt, then submit immediately.",
              verify:
                "Compare the actual session model and reasoning effort with the requested configuration; never copy requested settings into an observed capability report. A mismatch must be submitted as failure.",
            },
          }
        : {}),
      harness: config.harness,
      images,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      textAndTokens: "No VISP character or token ceiling; host/model context limits still apply",
      instructions:
        "Delegate once in a fresh context with the returned model/effort, packet, actual images and responseSchema. Use the exact generated argument list where the host permits it; Codex fallback includes --output-schema. Read only supplied evidence: no edits, execution, research, custom skills or further delegation. Save JSON unchanged at responsePath and immediately use submission.command. VISP constructs identity. Report actual host capabilities and failures honestly. Cancel at expiresAt; never automatically retry a pending invocation. Host authorization remains required.",
    },
  });
}
