import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";

export const DEBOUNCE_MS = 150;
const POLL_MS = 2_000;
/** A change that is not inside one feature: status, policy, config. */
export const ALL_FEATURES = "*";

export interface StateWatcher {
  close(): void;
}

/**
 * Reports which features changed under `.visp/`. Writers touch several files per
 * transaction, so changes are batched. Where the platform cannot watch a tree,
 * it falls back to polling the files that change on every workflow step.
 */
export function watchState(
  stateDir: string,
  onChange: (features: readonly string[]) => void,
): StateWatcher {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const features = [...pending];
    pending.clear();
    if (features.length > 0) onChange(features);
  };
  const record = (feature: string) => {
    pending.add(feature);
    timer ??= setTimeout(flush, DEBOUNCE_MS);
  };
  const watcher = tryWatch(stateDir, (filename) => record(featureOf(filename)));
  const poller = watcher ? undefined : pollState(stateDir, record);
  return {
    close() {
      watcher?.close();
      if (poller) clearInterval(poller);
      if (timer) clearTimeout(timer);
    },
  };
}

export function featureOf(filename: string | null): string {
  if (!filename) return ALL_FEATURES;
  const parts = filename.split(/[\\/]/);
  return parts[0] === "features" && parts[1] ? parts[1] : ALL_FEATURES;
}

function tryWatch(dir: string, onEvent: (filename: string | null) => void): FSWatcher | undefined {
  try {
    const watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) =>
      onEvent(filename === null ? null : filename.toString()),
    );
    watcher.on("error", () => watcher.close());
    return watcher;
  } catch {
    return undefined;
  }
}

function pollState(stateDir: string, record: (feature: string) => void): NodeJS.Timeout {
  let previous = new Map<string, number>();
  const tick = async () => {
    const current = await stamps(stateDir);
    for (const [path, mtime] of current) if (previous.get(path) !== mtime) record(featureOf(path));
    previous = current;
  };
  void tick();
  return setInterval(() => void tick(), POLL_MS).unref();
}

async function stamps(stateDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const note = async (relative: string) => {
    const info = await stat(join(stateDir, relative)).catch(() => undefined);
    if (info) result.set(relative, info.mtimeMs);
  };
  await note("status.json");
  const features = await readdir(join(stateDir, "features")).catch(() => [] as string[]);
  for (const feature of features) {
    await note(["features", feature, "product-state.json"].join(sep));
    await note(["features", feature, "brief.yaml"].join(sep));
  }
  return result;
}
