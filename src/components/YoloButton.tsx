import { Component, createSignal, Show } from "solid-js";
import { store, killAndClearAllTabs, setYoloMode } from "../lib/store";
import { Spinner, confirmDialog, toast } from "./ui";
import { triggerHaptic } from "../lib/ipc";

/** Toggles YOLO mode (dangerous permission bypass for supported agents).
 *  Closes all current agent tabs first since the bypass flag only applies
 *  to newly-spawned sessions. */
const YoloButton: Component = () => {
  const [busy, setBusy] = createSignal(false);

  async function toggleYolo() {
    if (busy()) return;
    void triggerHaptic("levelChange");
    if (store.yoloMode) {
      setYoloMode(false);
      toast("YOLO mode disabled", "info");
      return;
    }


    if (store.tabs.length > 0) {
      const confirmed = await confirmDialog(
        "YOLO mode will close all current agent tabs. New tabs will launch with dangerous permission bypass mode for supported agents.",
        "Enable YOLO"
      );
      if (!confirmed) return;
    }

    setBusy(true);
    try {
      if (store.tabs.length > 0) await killAndClearAllTabs();
      setYoloMode(true);
      toast("YOLO mode enabled", "info");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      class="yolo-toggle"
      classList={{ "yolo-toggle-active": store.yoloMode }}
      onclick={toggleYolo}
      disabled={busy()}
      title={store.yoloMode ? "YOLO mode is active for new agent sessions" : "Enable YOLO mode for new agent sessions"}
      style={{
        height: "30px",
        padding: "0 12px",
        "border-radius": "var(--radius-lg)",
        display: "flex", "align-items": "center", "justify-content": "center", gap: "7px",
        "font-size": "12px",
        "font-weight": "700",
        "letter-spacing": "0",
        opacity: busy() ? ".75" : "1",
        cursor: busy() ? "default" : "pointer",
      }}
    >
      <Show when={busy()} fallback={<span>YOLO</span>}>
        <Spinner size={12} color="#ffffff" />
      </Show>
    </button>
  );
};

export default YoloButton;
