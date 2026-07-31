import chokidar from "chokidar";
import { join } from "node:path";

export interface WatchHandle {
  close(): Promise<void>;
}

/**
 * Watches a resident app's src/ and berth.yml for changes during `berth dev`.
 * Debounced so a burst of saves (e.g. an editor writing several files) only
 * triggers one reload.
 */
export function watchApp(appDir: string, onChange: () => void, debounceMs = 200): WatchHandle {
  const watcher = chokidar.watch([join(appDir, "src"), join(appDir, "berth.yml")], {
    ignoreInitial: true,
  });

  let timer: NodeJS.Timeout | undefined;
  const scheduleChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  watcher.on("add", scheduleChange).on("change", scheduleChange).on("unlink", scheduleChange);

  return {
    async close() {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
