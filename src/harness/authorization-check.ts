import { PRODUCT_STATE_VERSION } from "../core/constants.js";

/** Embedded in the pre-commit fallback when the installed CLI cannot answer. */
export const AUTHORIZATION_CHECK = String.raw`
const { readFileSync, readdirSync, lstatSync } = require("node:fs");
const { join } = require("node:path");
let unknown = false;
function entries(directory) {
  try {
    if (lstatSync(directory).isSymbolicLink()) { unknown = true; return []; }
    return readdirSync(directory, { withFileTypes: true }).filter(entry => {
      if (entry.isSymbolicLink()) unknown = true;
      return entry.isFile() && entry.name.endsWith(".json");
    });
  } catch(error) {
    if (error?.code !== "ENOENT") unknown = true;
    return [];
  }
}
function read(path) {
  if (lstatSync(path).isSymbolicLink()) throw new Error("Linked state");
  return JSON.parse(readFileSync(path, "utf8"));
}
function validIdentity(marker) {
  return typeof marker?.feature === "string" && /^\d{3}-[a-z0-9][a-z0-9-]*$/.test(marker.feature)
    && typeof marker.task === "string" && /^T\d{3,}$/.test(marker.task);
}
for (const [directory, version] of [[".visp/state/product-authorizations", 2], [".visp/state/implement-allowed", 1]]) {
  for (const entry of entries(directory)) {
    try {
      const marker = read(join(directory, entry.name));
      if (!validIdentity(marker)) throw new Error("Invalid authorization identity");
      if (version === 2) {
        if (marker.version !== 2) throw new Error("Invalid product authorization");
        const state = read(join(".visp", "features", marker.feature, "product-state.json"));
        if (state?.version !== ${PRODUCT_STATE_VERSION} || state.feature !== marker.feature || !state.slices?.[marker.task]) throw new Error("Missing product state");
        const status = state.slices[marker.task].status;
        if (status === "closed" || status === "legacy-closed") continue;
        if (status !== "pending" && status !== "in-progress") throw new Error("Invalid slice status");
      } else {
        if (marker.kind !== "implement-marker") throw new Error("Invalid historical marker");
        const graph = read(join(".visp", "features", marker.feature, "tasks.json"));
        if (graph?.kind !== "tasks" || graph.feature !== marker.feature || !Array.isArray(graph.tasks)) throw new Error("Invalid historical graph");
        const matching = graph.tasks.filter(task => task?.id === marker.task);
        if (matching.length !== 1) throw new Error("Missing historical task");
        if (matching[0].status === "done") continue;
      }
      console.log("active");
      process.exit(0);
    } catch { unknown = true; }
  }
}
console.log(unknown ? "unknown" : "inactive");
`;
