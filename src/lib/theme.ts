// Custom theme model and token derivation. A theme only asks for five colors;
// the surrounding surfaces, borders and muted text are mixed from them so the
// rest of the app keeps readable contrast without exposing every token.
export interface CustomTheme {
  name: string;
  appearance: "light" | "dark";
  canvas: string;
  surface: string;
  foreground: string;
  accent: string;
}

const channels = (hex: string): [number, number, number] => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
const hex = (rgb: number[]): string => `#${rgb.map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")).join("")}`;

/** Same shape as `layout.normalizeHex`; kept local so layout can import this module without a cycle. */
export function normalizeThemeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  const raw = match[1].length === 3 ? [...match[1]].map((char) => char + char).join("") : match[1].slice(0, 6);
  return `#${raw.toLowerCase()}`;
}

function accentTokens(hexColor: string, scheme: "light" | "dark"): { accent: string; rgb: string; soft: string; onAccent: string } {
  const [r, g, b] = channels(hexColor);
  const lighten = (value: number) => Math.round(value + (255 - value) * 0.28);
  const soft = scheme === "dark" ? hex([lighten(r), lighten(g), lighten(b)]) : hexColor;
  return { accent: hexColor, rgb: `${r}, ${g}, ${b}`, soft, onAccent: contrastText(hexColor) };
}

function contrastText(hexColor: string): string {
  const [r, g, b] = channels(hexColor).map((value) => { const s = value / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b1411" : "#ffffff";
}

/** Mix `amount` (0–1) of `b` into `a`. */
export function mixColor(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return hex([ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount]);
}

/** A readable on-background text color derived from the chosen foreground. */
export function readableOn(background: string): string {
  return contrastText(background);
}

export function normalizeCustomTheme(value: unknown): CustomTheme | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const canvas = normalizeThemeColor(source.canvas);
  const surface = normalizeThemeColor(source.surface);
  const foreground = normalizeThemeColor(source.foreground);
  const accent = normalizeThemeColor(source.accent);
  if (!canvas || !surface || !foreground || !accent) return null;
  return {
    name: typeof source.name === "string" ? source.name.trim().slice(0, 60) : "Custom",
    appearance: source.appearance === "light" ? "light" : "dark",
    canvas,
    surface,
    foreground,
    accent,
  };
}

export function defaultCustomTheme(appearance: "light" | "dark" = "dark"): CustomTheme {
  return appearance === "light"
    ? { name: "Custom light", appearance, canvas: "#f3f4f6", surface: "#ffffff", foreground: "#141824", accent: "#4f46e5" }
    : { name: "Custom dark", appearance, canvas: "#0f1417", surface: "#1b2329", foreground: "#f1f6f7", accent: "#6366f1" };
}

/** CSS custom properties for a custom theme, in the same roles as the built-in themes. */
export function customThemeTokens(theme: CustomTheme): Record<string, string> {
  const dark = theme.appearance === "dark";
  const toward = dark ? "#ffffff" : "#000000";
  const accent = accentTokens(theme.accent, theme.appearance);
  const lift = (amount: number) => mixColor(theme.surface, toward, amount);
  return {
    "--surface-0": theme.canvas,
    "--surface-1": mixColor(theme.canvas, theme.surface, 0.55),
    "--surface-2": theme.surface,
    "--surface-3": lift(0.055),
    "--surface-4": lift(0.1),
    "--border-muted": mixColor(theme.surface, theme.foreground, 0.12),
    "--border-default": mixColor(theme.surface, theme.foreground, 0.24),
    "--border-strong": mixColor(theme.surface, theme.foreground, 0.52),
    "--fg-default": theme.foreground,
    "--fg-body": mixColor(theme.foreground, theme.canvas, 0.12),
    "--fg-muted": mixColor(theme.foreground, theme.canvas, 0.28),
    "--fg-subtle": mixColor(theme.foreground, theme.canvas, 0.42),
    "--fg-faint": mixColor(theme.foreground, theme.canvas, 0.54),
    "--accent": accent.accent,
    "--accent-rgb": accent.rgb,
    "--accent-soft": accent.soft,
    "--fg-on-accent": accent.onAccent,
    "--status-add": dark ? "#8ce0a7" : "#1a7f45",
    "--status-mod": dark ? "#eac06b" : "#8a5b00",
    "--status-del": dark ? "#ff929c" : "#b4233f",
    "--status-add-bg": dark ? "rgba(140,224,167,.10)" : "rgba(26,127,69,.08)",
    "--status-mod-bg": dark ? "rgba(234,192,107,.10)" : "rgba(138,91,0,.08)",
    "--status-del-bg": dark ? "rgba(255,146,156,.10)" : "rgba(180,35,63,.08)",
    "color-scheme": theme.appearance,
  };
}

export const CUSTOM_THEME_PROPERTIES = Object.keys(customThemeTokens(defaultCustomTheme()));
