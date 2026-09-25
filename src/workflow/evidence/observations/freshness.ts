import { hashValue } from "../../../core/hash.js";
import type { ContextManifest, ContextPack } from "../../artifacts/context.js";
import type {
  AcceptanceCriterion,
  QualityRequirement,
  Requirement,
  Spec,
} from "../../artifacts/feature.js";
import type { ObservationReceipt } from "../../artifacts/observations.js";
import { stableContextHash } from "../../stages/context/digest.js";
import { observationReproductionState } from "./identity.js";

export interface OwnedCriterion {
  readonly requirement: string;
  readonly requirementContract: Omit<Requirement | QualityRequirement, "criteria">;
  readonly criterion: AcceptanceCriterion;
}

export function staleReasonsFor(
  receipt: ObservationReceipt,
  spec: Spec | undefined,
  manifest: ContextManifest | undefined,
  pack: ContextPack | undefined,
  currentSourceHash: string | undefined,
): string[] {
  if (receipt.subjectHash) {
    return semanticStaleReasons(receipt, spec, manifest, pack, currentSourceHash);
  }

  // Legacy receipts intentionally retain their original full-artifact
  // comparison. Reading old evidence must not reinterpret or rewrite it.
  const legacySpecHash = spec ? hashValue(spec) : undefined;
  const legacyManifestHash = manifest ? hashValue(manifest) : undefined;
  return [
    ...(receipt.specHash === legacySpecHash ? [] : ["spec changed"]),
    ...(receipt.contextManifestHash === legacyManifestHash ? [] : ["context manifest changed"]),
  ];
}

function semanticStaleReasons(
  receipt: ObservationReceipt,
  spec: Spec | undefined,
  manifest: ContextManifest | undefined,
  pack: ContextPack | undefined,
  currentSourceHash: string | undefined,
): string[] {
  const owned = spec
    ? findOwnedCriterion(
        [...spec.requirements, ...spec.qualityRequirements],
        receipt.requirement,
        receipt.criterion,
      )
    : undefined;
  const specHash = owned ? criterionContractHash(owned) : undefined;
  const contextHash = manifest?.contextHash;
  const contextCurrent = isSemanticContextCurrent(manifest, pack);
  const sourceCurrent = isObservationSourceCurrent(receipt, currentSourceHash);
  const subjectHash = currentSemanticObservationHash(
    receipt,
    owned,
    contextHash,
    contextCurrent,
    sourceCurrent,
    currentSourceHash,
  );
  const reasons: string[] = [];
  if (receipt.specHash !== specHash) reasons.push("criterion contract changed");
  if (receipt.contextManifestHash !== contextHash) reasons.push("context manifest changed");
  if (semanticContextPackMissing(receipt, contextHash, manifest, pack)) {
    reasons.push("context pack missing");
  }
  if (semanticContextContentChanged(receipt, contextHash, manifest, pack, contextCurrent)) {
    reasons.push("context pack stable content changed");
  }
  if (receipt.sourceHash && !sourceCurrent) reasons.push("relevant source changed");
  if (
    semanticSubjectChanged(
      receipt,
      specHash,
      contextHash,
      contextCurrent,
      sourceCurrent,
      subjectHash,
    )
  ) {
    reasons.push("observation subject changed");
  }
  return reasons;
}

function isSemanticContextCurrent(
  manifest: ContextManifest | undefined,
  pack: ContextPack | undefined,
): boolean {
  if (!manifest || !pack) return false;
  return manifest.contextHash === stableContextHash(pack, manifest.graphSnapshotId);
}

function isObservationSourceCurrent(
  receipt: ObservationReceipt,
  currentSourceHash: string | undefined,
): boolean {
  return receipt.sourceHash === undefined || receipt.sourceHash === currentSourceHash;
}

function currentSemanticObservationHash(
  receipt: ObservationReceipt,
  owned: OwnedCriterion | undefined,
  contextHash: string | undefined,
  contextCurrent: boolean,
  sourceCurrent: boolean,
  currentSourceHash: string | undefined,
): string | undefined {
  if (!owned || !contextHash || !contextCurrent || !sourceCurrent) return undefined;
  return semanticObservationHash(
    owned,
    contextHash,
    observationReproductionState(receipt),
    receipt.sourceHash ? currentSourceHash : undefined,
  );
}

function semanticContextPackMissing(
  receipt: ObservationReceipt,
  contextHash: string | undefined,
  manifest: ContextManifest | undefined,
  pack: ContextPack | undefined,
): boolean {
  return (
    receipt.contextManifestHash === contextHash && manifest !== undefined && pack === undefined
  );
}

function semanticContextContentChanged(
  receipt: ObservationReceipt,
  contextHash: string | undefined,
  manifest: ContextManifest | undefined,
  pack: ContextPack | undefined,
  contextCurrent: boolean,
): boolean {
  return (
    receipt.contextManifestHash === contextHash &&
    manifest !== undefined &&
    pack !== undefined &&
    !contextCurrent
  );
}

function semanticSubjectChanged(
  receipt: ObservationReceipt,
  specHash: string | undefined,
  contextHash: string | undefined,
  contextCurrent: boolean,
  sourceCurrent: boolean,
  subjectHash: string | undefined,
): boolean {
  return (
    receipt.specHash === specHash &&
    receipt.contextManifestHash === contextHash &&
    contextCurrent &&
    sourceCurrent &&
    receipt.subjectHash !== subjectHash
  );
}

export function semanticObservationHash(
  owned: OwnedCriterion,
  contextHash: string,
  state: object,
  sourceHash?: string,
): string {
  return hashValue({
    requirement: owned.requirementContract,
    criterion: owned.criterion,
    contextHash,
    state,
    ...(sourceHash ? { sourceHash } : {}),
  });
}

export function criterionContractHash(owned: OwnedCriterion): string {
  return hashValue({ requirement: owned.requirementContract, criterion: owned.criterion });
}

function findOwnedCriterion(
  requirements: readonly (Requirement | QualityRequirement)[],
  requirementId: string,
  criterionId: string,
): OwnedCriterion | undefined {
  const requirement = requirements.find((candidate) => candidate.id === requirementId);
  const criterion = requirement?.criteria.find((candidate) => candidate.id === criterionId);
  return requirement && criterion ? ownedCriterionView(requirement, criterion) : undefined;
}

export function ownedCriterionView(
  requirement: Requirement | QualityRequirement,
  criterion: AcceptanceCriterion,
): OwnedCriterion {
  const { criteria: _criteria, ...requirementContract } = requirement;
  return { requirement: requirement.id, requirementContract, criterion };
}
