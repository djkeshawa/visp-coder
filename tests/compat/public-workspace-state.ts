import type { VispConfig } from "../../src/config/schema.js";
import type { ProjectPaths } from "../../src/core/paths.js";
import { resolveFeature, type WorkspaceState } from "../../src/index.js";
import type { Status } from "../../src/workflow/artifacts/project.js";
import type { ArtifactStore } from "../../src/workflow/artifacts/store.js";
import type { Override, Policy } from "../../src/workflow/policy/schema.js";

declare const paths: ProjectPaths;
declare const store: ArtifactStore;
declare const config: VispConfig;
declare const policy: Policy;
declare const overrides: readonly Override[];
declare const status: Status | undefined;

// This is the public 0.1 construction shape. In particular, it has no `files`
// property; keeping this fixture type-correct protects source compatibility.
const legacyState: WorkspaceState = {
  paths,
  store,
  config,
  policy,
  overrides,
  status,
};

void resolveFeature(legacyState);
void resolveFeature(legacyState, "001-existing");
