import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { Presence } from "./ui";
import { Icon } from "./shell/Icon";
import { LICENSES, type LicenseEntry } from "../lib/licenses";

const [openLicensesSignal, setOpenLicensesSignal] = createSignal(false);
export { openLicensesSignal };
export function openLicenses() { setOpenLicensesSignal(true); }

/** T3-style Settings → About → Open source licenses: searchable notices with full text. */
const LicensesDialog: Component = () => {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string | null>(null);
  const close = () => setOpenLicensesSignal(false);
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) return LICENSES;
    return LICENSES.filter((entry) => [entry.name, entry.version, entry.license, entry.usage].join(" ").toLowerCase().includes(needle));
  });
  const current = (): LicenseEntry | undefined => LICENSES.find((entry) => entry.name === selected());

  return (
    <Presence when={openLicensesSignal()}>
      <div class="overlay-backdrop-in" onClick={close}
        style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.48)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in" role="dialog" aria-modal="true" aria-label="Open source licenses" tabindex={-1}
          onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { if (selected()) setSelected(null); else close(); } }}
          ref={(el) => queueMicrotask(() => el.focus())}
          style={{ width: "min(760px, 100%)", "max-height": "86vh", display: "flex", "flex-direction": "column", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)", overflow: "hidden" }}>
          <header style={{ display: "flex", "align-items": "center", gap: "10px", padding: "14px 18px", "border-bottom": "1px solid var(--border-muted)" }}>
            <Show when={selected()}>
              <button class="icon-btn" onClick={() => setSelected(null)} title="Back to the list" aria-label="Back to the list"><Icon name="arrowLeft" size={14} /></button>
            </Show>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)", flex: 1 }}>
              {selected() ? current()?.name ?? "License" : "Open source licenses"}
            </span>
            <Show when={!selected()}>
              <input class="ui-field" style={{ width: "200px" }} type="search" placeholder="Search packages, licenses…" aria-label="Search licenses"
                value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
            </Show>
            <button class="icon-btn press" onClick={close} title="Close" aria-label="Close licenses"><Icon name="x" size={14} /></button>
          </header>
          <div style={{ padding: "10px 18px 16px", overflow: "auto", display: "flex", "flex-direction": "column", gap: "6px" }}>
            <Show when={selected()} fallback={
              <>
                <p style={{ margin: "0 0 6px", "font-size": "12px", color: "var(--fg-muted)", "line-height": "1.5" }}>
                  FlipFlopper bundles these open-source packages. Select a row for the full notice; no network access is used here.
                </p>
                <For each={filtered()} fallback={<div style={{ "font-size": "12.5px", color: "var(--fg-subtle)" }}>No package matches that search.</div>}>
                  {(entry) => (
                    <button type="button" class="licenses-row" style={{ display: "flex", "align-items": "center", gap: "10px", padding: "7px 9px", "border-radius": "8px", border: "1px solid var(--border-muted)", background: "var(--surface-2)", cursor: "pointer", "text-align": "left" }}
                      onClick={() => setSelected(entry.name)}>
                      <span style={{ flex: 1, "min-width": 0, display: "flex", "flex-direction": "column", gap: "2px" }}>
                        <span style={{ "font-size": "12.5px", color: "var(--fg-default)" }}>{entry.name} <span style={{ color: "var(--fg-subtle)" }}>{entry.version}</span></span>
                        <span style={{ "font-size": "11.5px", color: "var(--fg-subtle)" }}>{entry.usage}</span>
                      </span>
                      <span style={{ "font-size": "11px", color: "var(--fg-muted)", "white-space": "nowrap" }}>{entry.license}</span>
                      <Icon name="chevronRight" size={12} />
                    </button>
                  )}
                </For>
              </>
            }>
              <div style={{ display: "flex", gap: "10px", "flex-wrap": "wrap", "font-size": "12px", color: "var(--fg-muted)" }}>
                <span>{current()?.name} {current()?.version}</span><span>·</span><span>{current()?.license}</span><span>·</span><span>{current()?.usage}</span>
              </div>
              <pre style={{ margin: "4px 0 0", padding: "12px", background: "var(--surface-2)", border: "1px solid var(--border-muted)", "border-radius": "8px", "white-space": "pre-wrap", "overflow-wrap": "anywhere", "font-size": "11.5px", "line-height": "1.5", color: "var(--fg-body)", "max-height": "52vh", overflow: "auto" }}>{current()?.text}</pre>
            </Show>
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default LicensesDialog;
