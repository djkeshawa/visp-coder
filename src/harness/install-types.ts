import type { Harness, Profile } from "../core/constants.js";
import type { applyFileTransaction, FileMutation } from "../core/file-transaction.js";
import type { Result } from "../core/result.js";
import type { ActivationStatus } from "./activation.js";
import type { RegistrationStatus as ClaudeSettingsStatus } from "./claude-settings.js";
import type { RegistrationStatus } from "./mcp-registration.js";

export type AssetStatus = "written" | "unchanged" | "skipped-modified" | "removed";

export interface InstalledAsset {
  readonly path: string;
  readonly status: AssetStatus;
}

export interface InstallOutcome {
  readonly harness: Harness;
  readonly assets: readonly InstalledAsset[];
  readonly manualSteps: readonly string[];
  readonly activation?: ActivationStatus;
  readonly settingsSnippet?: string;
  readonly claudeSettings?: ClaudeSettingsStatus;
  readonly mcp?: RegistrationStatus;
  readonly mcpConfigFile?: string;
  readonly requirements: readonly string[];
}

export interface InstallPreview {
  readonly dryRun: true;
  readonly harness: Harness;
  readonly profile: Profile;
  readonly localEnforcement: "requested" | "omitted";
  readonly repositoryAvailable: boolean;
  readonly hasBaseline: boolean;
  readonly changedFiles?: readonly string[];
  readonly changes: readonly {
    readonly operation: "write" | "remove";
    readonly path: string;
    readonly mode?: number;
  }[];
  readonly requirements: readonly string[];
  readonly manualSteps: readonly string[];
}

export interface InstallOptions {
  readonly harness: Harness;
  readonly profile?: Profile;
  readonly force?: boolean;
  readonly hooks?: readonly HookKind[];
  readonly mcp?: boolean;
  readonly prunePreviousHarness?: boolean;
  /** Explicit CLI choices persisted inside the installation transaction. */
  readonly configUpdates?: { readonly harness?: Harness; readonly profile?: Profile };
}

export interface InstallRuntime {
  /** Test seam for exercising the installer's complete mutation plan. */
  readonly applyTransaction?: (
    root: string,
    label: string,
    mutations: readonly FileMutation[],
  ) => ReturnType<typeof applyFileTransaction>;
  /** Test seam for a concurrent change between commit and post-install verification. */
  readonly afterApply?: () => void | Promise<void>;
  /** Test seam; production executes the same external guard handshake used by doctor. */
  readonly guardHandshake?: (root: string) => Promise<Result<void>>;
}

export type HookKind = "claude" | "git" | "ci";

export type AssetManifest = Record<string, string>;

export interface InstallPlan {
  readonly assets: InstalledAsset[];
  readonly mutations: FileMutation[];
  readonly fingerprints: AssetManifest;
  readonly removals: string[];
  readonly manualSteps: string[];
  expectedManifest: string;
  expectedConfig: string | undefined;
  settingsSnippet?: string;
  claudeSettings?: ClaudeSettingsStatus;
  mcp?: RegistrationStatus;
  mcpConfigFile?: string;
  activation?: ActivationStatus;
}
