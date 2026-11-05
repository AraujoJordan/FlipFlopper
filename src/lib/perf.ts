/** Dev-only startup marks. `perf_mark` prints to the terminal running `tauri dev`,
 *  so startup work can be measured without devtools. */
import { invoke } from "@tauri-apps/api/core";

export function mark(label: string) {
  if (!import.meta.env.DEV && !window.location.search.includes("ffperf")) return;
  void invoke("perf_mark", { label, ms: performance.now(), wall: Date.now() }).catch(() => {});
}
