import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { registerShortcutHandler, SHORTCUT_GROUPS } from "../lib/shortcuts";

/** Keyboard-shortcut reference modal, opened with "?" (see shortcuts.ts) or
 *  the help button in the title bar. Purely informational — closes on
 *  Escape or backdrop click, same pattern as OmniSearch. */
const ShortcutHelp: Component = () => {
  const [open, setOpen] = createSignal(false);
  let dialogRef: HTMLDivElement | undefined;

  onMount(() => {
    const unregister = registerShortcutHandler("shortcut-help", () => setOpen(true));
    onCleanup(unregister);
  });

  function close() {
    setOpen(false);
  }

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  return (
    <Show when={open()}>
      <div
        class="overlay-backdrop-in"
        onclick={close}
        style={{
          position: "fixed", inset: 0, "z-index": "var(--z-modal)",
          background: "rgba(0,0,0,.48)",
          display: "flex", "align-items": "center", "justify-content": "center",
          padding: "24px",
        }}
      >
        <div
          ref={dialogRef}
          class="overlay-pop-in"
          tabindex={-1}
          onclick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
          style={{
            width: "min(420px, 100%)",
            "max-height": "80vh",
            overflow: "auto",
            background: "var(--surface-3)",
            border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-xl)",
            "box-shadow": "var(--shadow-menu)",
            padding: "18px 20px",
          }}
        >
          <div style={{
            display: "flex", "align-items": "center", "justify-content": "space-between",
            "margin-bottom": "14px",
          }}>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)" }}>
              Keyboard shortcuts
            </span>
            <button
              class="icon-btn press"
              onclick={close}
              title="Close"
              aria-label="Close shortcuts reference"
              style={{ display: "flex", "align-items": "center", "justify-content": "center", padding: "3px", color: "var(--fg-subtle)" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <For each={SHORTCUT_GROUPS}>
            {(group) => (
              <div style={{ "margin-bottom": "14px" }}>
                <div style={{
                  "font-size": "10.5px", "letter-spacing": ".5px", "text-transform": "uppercase",
                  color: "var(--fg-subtle)", "font-weight": "600", "margin-bottom": "6px",
                }}>
                  {group.label}
                </div>
                <For each={group.items}>
                  {(item) => (
                    <div style={{
                      display: "flex", "align-items": "center", "justify-content": "space-between",
                      gap: "12px", padding: "5px 0",
                    }}>
                      <span style={{ "font-size": "12.5px", color: "var(--fg-body)" }}>{item.description}</span>
                      <span style={{
                        "font-family": "var(--font-mono)", "font-size": "11px",
                        color: "var(--fg-muted)", background: "var(--surface-4)",
                        border: "1px solid var(--border-default)", "border-radius": "var(--radius-sm)",
                        padding: "1px 6px", "white-space": "nowrap", "flex-shrink": "0",
                      }}>
                        {item.keys}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default ShortcutHelp;
