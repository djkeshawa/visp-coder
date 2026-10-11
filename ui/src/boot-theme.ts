import { applyTheme } from "./theme.js";

// Loaded before the stylesheet paints so a dark-mode user never sees a white flash.
applyTheme();
