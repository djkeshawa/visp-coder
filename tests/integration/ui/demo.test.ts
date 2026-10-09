import { writeFile } from "node:fs/promises";
import { it } from "vitest";
import { uiScenario } from "../../unit/support/ui-scenario.js";

/**
 * Seeds a throwaway repository with real recorded workflow state for trying the
 * dashboard by hand. Off by default:
 *   VISP_UI_DEMO=/tmp/visp-ui-demo.txt pnpm vitest run tests/integration/ui/demo.test.ts
 *   visp ui --project "$(cat /tmp/visp-ui-demo.txt)"
 */
it.skipIf(!process.env.VISP_UI_DEMO)(
  "seeds a demo repository for visp ui",
  async () => {
    const { workspace } = await uiScenario();
    await writeFile(process.env.VISP_UI_DEMO as string, workspace.root);
  },
  120_000,
);
