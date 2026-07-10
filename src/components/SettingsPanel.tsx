import { Component, Show, createSignal } from "solid-js";
import { store, toggleAutoToggleSidebars } from "../lib/store";
import {
  getIdleTimeoutMinutes, setIdleTimeoutMinutes,
  MIN_IDLE_TIMEOUT_MINUTES, MAX_IDLE_TIMEOUT_MINUTES,
} from "../lib/settings";
import { Checkbox, Input } from "./ui";

/** Settings modal. Deliberately scoped to a handful of genuinely user-facing
 *  preferences rather than every localStorage-backed key in store.ts — most
 *  of those (recent run/validation targets, continue-agent usage, etc.) are
 *  per-project cached selections a user would never browse or reset, not
 *  settings. YOLO mode isn't here either: it has its own confirm-before-enable
 *  flow in YoloButton that this panel shouldn't bypass. */
const SettingsPanel: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const [idleMinutes, setIdleMinutesLocal] = createSignal(getIdleTimeoutMinutes());

  function commitIdleMinutes(raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setIdleTimeoutMinutes(n);
    setIdleMinutesLocal(getIdleTimeoutMinutes());
  }

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <Show when={props.open}>
      <div
        class="overlay-backdrop-in"
        onclick={props.onClose}
        style={{
          position: "fixed", inset: 0, "z-index": "var(--z-modal)",
          background: "rgba(0,0,0,.48)",
          display: "flex", "align-items": "center", "justify-content": "center",
          padding: "24px",
        }}
      >
        <div
          class="overlay-pop-in"
          tabindex={-1}
          onclick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
          style={{
            width: "min(420px, 100%)",
            background: "var(--surface-3)",
            border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-xl)",
            "box-shadow": "var(--shadow-menu)",
            padding: "18px 20px",
          }}
        >
          <div style={{
            display: "flex", "align-items": "center", "justify-content": "space-between",
            "margin-bottom": "16px",
          }}>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)" }}>
              Settings
            </span>
            <button
              class="icon-btn press"
              onclick={props.onClose}
              title="Close"
              aria-label="Close settings"
              style={{ display: "flex", "align-items": "center", "justify-content": "center", padding: "3px", color: "var(--fg-subtle)" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
            <div>
              <Checkbox
                checked={store.autoToggleSidebars}
                onChange={() => toggleAutoToggleSidebars()}
                label="Auto-toggle sidebars"
              />
              <div style={{ "font-size": "11px", color: "var(--fg-subtle)", "margin-left": "22px", "margin-top": "3px" }}>
                Show or hide the explorer and git panel automatically based on the active workspace mode.
              </div>
            </div>

            <div>
              <label style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "12.5px", color: "var(--fg-body)" }}>
                Agent idle alert
                <Input
                  value={String(idleMinutes())}
                  onInput={setIdleMinutesLocal}
                  onKeyDown={(e) => { if (e.key === "Enter") commitIdleMinutes((e.currentTarget as HTMLInputElement).value); }}
                  onBlur={(e) => commitIdleMinutes((e.currentTarget as HTMLInputElement).value)}
                  style={{ width: "56px", padding: "4px 8px" }}
                />
                minutes
              </label>
              <div style={{ "font-size": "11px", color: "var(--fg-subtle)", "margin-top": "3px" }}>
                How long an agent session can sit silent before it's flagged as needing attention ({MIN_IDLE_TIMEOUT_MINUTES}–{MAX_IDLE_TIMEOUT_MINUTES}).
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default SettingsPanel;
