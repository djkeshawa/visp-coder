import { cp } from "node:fs/promises";
import { it } from "vitest";
import { uiScenario } from "../../unit/support/ui-scenario.js";

/**
 * Seeds a repository with real recorded workflow state for trying the dashboard by
 * hand. Test workspaces are deleted when the run ends, so the repository is copied
 * to the directory named. Off by default:
 *   VISP_UI_DEMO=/tmp/visp-ui-demo pnpm vitest run tests/integration/ui/demo.test.ts
 *   visp ui --project /tmp/visp-ui-demo
 */
it.skipIf(!process.env.VISP_UI_DEMO)(
  "seeds a demo repository for visp ui",
  async () => {
    const { workspace } = await uiScenario();
    await cp(workspace.root, process.env.VISP_UI_DEMO as string, { recursive: true });
  },
  120_000,
);
