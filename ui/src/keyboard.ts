import { actions } from "./actions.js";
import { refreshVisible } from "./resources.js";
import { navigate } from "./router.js";
import { TABS } from "./state.js";
import { state } from "./store.js";

export function onKey(event: KeyboardEvent): void {
  const typing =
    event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
  if (event.key === "Escape") {
    if (state.showHelp) actions.toggleHelp();
    else if (state.route.view === "feature" && state.route.run) {
      const { run: _run, ...rest } = state.route;
      navigate(rest);
    }
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const index = Number(event.key) - 1;
  if (state.route.view === "feature" && index >= 0 && index < TABS.length) {
    navigate({ view: "feature", feature: state.route.feature, tab: TABS[index] ?? "now" });
  } else if (event.key === "n") navigate({ view: "needs" });
  else if (event.key === "r") refreshVisible();
  else if (event.key === "?") actions.toggleHelp();
}
