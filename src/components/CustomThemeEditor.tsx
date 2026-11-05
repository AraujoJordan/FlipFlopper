import { Component, For, Show } from "solid-js";
import { layout, setCustomTheme } from "../lib/layout";
import { customThemeTokens, defaultCustomTheme, normalizeThemeColor, type CustomTheme } from "../lib/theme";
import { writeClipboardText } from "../lib/native";
import { toast } from "./ui";
import { Icon } from "./shell/Icon";

const FIELDS: { key: "canvas" | "surface" | "foreground" | "accent"; label: string; hint: string }[] = [
  { key: "canvas", label: "Background", hint: "Sidebar and outer frame" },
  { key: "surface", label: "Surface", hint: "Conversation, cards and menus" },
  { key: "foreground", label: "Text", hint: "Primary text and icons" },
  { key: "accent", label: "Accent", hint: "Actions, focus and selected rows" },
];

/** Settings → Appearance → Custom theme: five colors drive the full palette. */
const CustomThemeEditor: Component = () => {
  const theme = () => layout.customTheme;

  const update = (patch: Partial<CustomTheme>) => {
    const current = theme();
    if (!current) return;
    setCustomTheme({ ...current, ...patch });
  };

  const updateColor = (key: "canvas" | "surface" | "foreground" | "accent", value: string) => {
    const clean = normalizeThemeColor(value);
    if (clean) update({ [key]: clean });
  };

  const create = () => setCustomTheme(defaultCustomTheme(layout.theme === "light" ? "light" : "dark"));

  const copyJson = async () => {
    const current = theme();
    if (!current) return;
    try {
      await writeClipboardText(JSON.stringify(current, null, 2), "theme");
      toast("Theme JSON copied", "success");
    } catch (error) {
      toast(`Couldn't copy the theme: ${String(error)}`, "error");
    }
  };

  const tokens = () => {
    const current = theme();
    return current ? customThemeTokens(current) : null;
  };

  return (
    <Show
      when={theme()}
      fallback={
        <div class="theme-editor-empty">
          <div>
            <strong>Custom theme</strong>
            <span>Create a palette from a background, surface, text and accent color. The surrounding borders and muted text are derived automatically.</span>
          </div>
          <button type="button" class="ui-btn ui-btn-outline" onClick={create}><Icon name="sparkle" size={13} /> Create theme</button>
        </div>
      }
    >
      {(current) => (
        <div class="theme-editor">
          <div class="theme-editor-head">
            <input class="ui-field theme-name" aria-label="Theme name" value={current().name} maxLength={60}
              onInput={(event) => update({ name: event.currentTarget.value })} />
            <div class="seg" role="group" aria-label="Theme appearance">
              <For each={["dark", "light"] as const}>
                {(appearance) => (
                  <button type="button" class="seg-btn" aria-pressed={current().appearance === appearance}
                    classList={{ "seg-on": current().appearance === appearance }}
                    onClick={() => update({ appearance })}>{appearance === "dark" ? "Dark" : "Light"}</button>
                )}
              </For>
            </div>
            <button type="button" class="icon-btn" title="Copy theme JSON" aria-label="Copy theme JSON" onClick={() => void copyJson()}><Icon name="copy" size={14} /></button>
            <button type="button" class="ui-btn ui-btn-ghost" onClick={() => setCustomTheme(null)}>Use built-in theme</button>
          </div>

          <div class="theme-editor-fields">
            <For each={FIELDS}>
              {(field) => (
                <label class="theme-color-field">
                  <input type="color" aria-label={`${field.label} color`} value={current()[field.key]}
                    onInput={(event) => updateColor(field.key, event.currentTarget.value)} />
                  <span class="theme-color-copy">
                    <strong>{field.label}</strong>
                    <small>{field.hint}</small>
                  </span>
                  <input class="ui-field theme-hex" aria-label={`${field.label} hex`} value={current()[field.key]} maxLength={9}
                    onInput={(event) => updateColor(field.key, event.currentTarget.value)} />
                </label>
              )}
            </For>
          </div>

          <Show when={tokens()}>
            {(palette) => (
              <div class="theme-preview" style={Object.entries(palette()).map(([name, value]) => `${name}:${value}`).join(";")}>
                <div class="theme-preview-title"><Icon name="sparkle" size={13} /> {current().name || "Custom theme"}</div>
                <p>Body text stays readable while the derived borders and muted text keep their distance.</p>
                <div class="theme-preview-row">
                  <span class="theme-preview-chip">surface</span>
                  <span class="theme-preview-chip">border</span>
                  <span class="theme-preview-accent">Accent action</span>
                </div>
              </div>
            )}
          </Show>
          <p class="theme-editor-note">The accent color in the row above is kept for when you return to a built-in theme.</p>
        </div>
      )}
    </Show>
  );
};

export default CustomThemeEditor;
