import { createStore, produce } from "solid-js/store";
import { batch, createSignal } from "solid-js";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readPref, writePref } from "./appPrefs";
import { CUSTOM_THEME_PROPERTIES, customThemeTokens, normalizeCustomTheme, type CustomTheme } from "./theme";

export type SideTab = "changes" | "preview" | "flow" | "explain" | "files" | "pulls" | "sidechat";
export type ThemePref = "system" | "light" | "dark";
export type MotionPref = "system" | "reduced" | "off";
export type ChatWidth = "comfortable" | "wide" | "full";
export type ResolvedMotion = "full" | "reduced" | "off";
export const MOTION_EVENT = "flipflopper:motion-changed";
export const ZOOM_EVENT = "flipflopper:zoom-changed";
export const CODE_SCALE_EVENT = "flipflopper:code-scale-changed";
/** Code text (tool output, code blocks, diffs, terminals) scales independently of interface zoom. */
export const CODE_SCALES = [0.85, 0.9, 1, 1.1, 1.2, 1.3, 1.4] as const;
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.33, 1.5, 1.75, 2.0] as const;
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const [motionReady, setMotionReady] = createSignal(false);
const [osReduced, setOsReduced] = createSignal(false);
const [foreground, setForeground] = createSignal(true);
const [mainWidth, setMainWidth] = createSignal(0);
const [rootWidth, setRootWidth] = createSignal(0);
export const sidebarIsOverlay = () => rootWidth() < layout.sidebarWidth + CONVERSATION_MIN + PANEL_INSET * 2;
export const renderedSidebarWidth = () => Math.min(layout.sidebarWidth, Math.max(0, rootWidth() - PANEL_INSET * 2));
export const paneIsOverlay = () => resolveSidePane(mainWidth(), layout.sideWidth).overlay;
export const renderedSideWidth = () => resolveSidePane(mainWidth(), layout.sideWidth).width;
export const motionForeground = foreground;
const motionSettlers = new Set<() => void>();
export function registerMotionSettler(settle: () => void) {
  motionSettlers.add(settle);
  return () => { motionSettlers.delete(settle); };
}
export function resolvedMotion(): ResolvedMotion {
  return !motionReady() || layout.motion === "off" ? "off" : layout.motion === "reduced" || osReduced() ? "reduced" : "full";
}
function settleMotion() {
  for (const settle of [...motionSettlers]) settle();
}
function applyMotion() {
  settleMotion();
  document.documentElement.dataset.motion = resolvedMotion();
  window.dispatchEvent(new Event(MOTION_EVENT));
}
/** Owned by the app, including hot reload/unmount cleanup. Never pauses chat. */
export function watchMotionPreferences() {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => { setOsReduced(media.matches); applyMotion(); };
  const visibility = () => {
    setForeground(!document.hidden);
    document.documentElement.dataset.motionPaused = String(document.hidden);
    if (document.hidden) settleMotion();
    window.dispatchEvent(new Event(MOTION_EVENT));
  };
  reduced(); visibility();
  media.addEventListener("change", reduced);
  document.addEventListener("visibilitychange", visibility);
  return () => { media.removeEventListener("change", reduced); document.removeEventListener("visibilitychange", visibility); settleMotion(); };
}
export function setMotion(motion: MotionPref) {
  setLayout("motion", motion);
  applyMotion();
  persist();
}

export function setPanelMotionMs(value: number) {
  const next = Math.min(400, Math.max(0, Math.round(Number.isFinite(value) ? value : 240)));
  if (layout.panelMotionMs === next) return;
  setLayout("panelMotionMs", next);
  persist();
}

interface LayoutState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  sideOpen: boolean;
  sideTab: SideTab;
  sideWidth: number;
  theme: ThemePref;
  motion: MotionPref;
  /** Duration of sidebar/right-panel open and close motion, in ms (0 = immediate). */
  panelMotionMs: number;
  chatWidth: ChatWidth;
  /** Bottom terminal drawer under the conversation. */
  terminalDrawer: boolean;
  terminalDrawerHeight: number;
  zoom: number;
  codeScale: number;
  /** Custom accent color (#rrggbb), or `null` for the theme's own. */
  accent: string | null;
  /** A user-created palette taking precedence over the built-in theme. */
  customTheme: CustomTheme | null;
  /** Custom font families; `null` keeps the built-in stacks. */
  uiFont: string | null;
  codeFont: string | null;
  /** Show only each finished turn's final reply (hides thinking, tool rows and earlier text). */
  focusView: boolean;
  /** Sidebar: sessions that are running or waiting for you get their own "Working" group. */
  workingGroup: boolean;
  /** Scratch folders the user turned into regular projects. */
  promotedScratch: string[];
  /** Sidebar grouping: by project, or by recency. */
  sidebarGroup: "project" | "date";
  /** Project path the sidebar is filtered to, or null for all. */
  projectFilter: string | null;
  projectOrder: string[];
  projectNames: Record<string, string>;
  /** Per-project monogram overrides: up to two letters and/or a hue. */
  projectIcons: Record<string, ProjectIcon>;
  /** Manual sidebar order for sessions; new sessions without a position stay on top. */
  sessionOrder: string[];
  pinnedProjects: string[];
  hiddenProjects: string[];
}

const KEY = "flipflopper:layout";
/** Mirrored for index.html's first paint; keep the literal in sync with it. */
const BOOT_THEME_KEY = "flipflopper:boot-theme";

const DEFAULTS: LayoutState = {
  sidebarOpen: true,
  sidebarWidth: 272,
  sideOpen: false,
  sideTab: "changes",
  sideWidth: 480,
  theme: "system",
  motion: "system",
  panelMotionMs: 240,
  chatWidth: "comfortable",
  terminalDrawer: false,
  terminalDrawerHeight: 280,
  zoom: 1,
  codeScale: 1,
  accent: null,
  customTheme: null,
  uiFont: null,
  codeFont: null,
  focusView: false,
  workingGroup: false,
  promotedScratch: [],
  sidebarGroup: "project",
  projectFilter: null,
  projectOrder: [],
  projectNames: {},
  projectIcons: {},
  sessionOrder: [],
  pinnedProjects: [],
  hiddenProjects: [],
};

export const [layout, setLayout] = createStore<LayoutState>({ ...DEFAULTS });

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 420;
export const SIDE_MIN = 340;
export const CONVERSATION_MIN = 520;
export const PANEL_INSET = 8;
export const PANEL_GAP = 8;

/** Inputs are unzoomed layout pixels, measured from the actual flex containers. */
export function resolveSidePane(available: number, preferred: number) {
  const space = Math.max(0, Number.isFinite(available) ? available : 0);
  const wanted = Math.max(SIDE_MIN, Number.isFinite(preferred) ? preferred : DEFAULTS.sideWidth);
  const overlay = space < CONVERSATION_MIN + SIDE_MIN + PANEL_GAP;
  return { overlay, width: Math.min(wanted, overlay ? space : space - CONVERSATION_MIN - PANEL_GAP) };
}

export function watchLayoutSizes(root: HTMLElement, main: HTMLElement) {
  // contentRect accounts for CSS zoom and native WebView zoom without dividing twice.
  const observer = new ResizeObserver((entries) => batch(() => {
    for (const entry of entries) {
      if (entry.target === root) setRootWidth(entry.contentRect.width);
      if (entry.target === main) setMainWidth(entry.contentRect.width);
    }
  }));
  setRootWidth(root.clientWidth);
  setMainWidth(main.clientWidth);
  observer.observe(root);
  observer.observe(main);
  return () => observer.disconnect();
}

function persist() {
  writePref(KEY, { ...layout });
}

/** Mirror the resolved appearance for index.html's boot canvas. preferences.json
 *  is read asynchronously, so this keeps the first paint (and the capped reveal
 *  fallback) on the persisted theme instead of the system palette. */
function syncBootTheme() {
  try {
    localStorage.setItem(BOOT_THEME_KEY, layout.customTheme ? layout.customTheme.appearance : layout.theme);
  } catch {
    // Storage can be unavailable; the boot script then follows the system theme.
  }
}

export function applyTheme(theme: ThemePref) {
  const root = document.documentElement;
  root.dataset.themeSwitching = "true";
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  // Flush the token swap with transitions disabled so text/surface pairs never
  // pass through mismatched contrast during a theme change.
  void root.offsetHeight;
  delete root.dataset.themeSwitching;
  syncBootTheme();
  // Terminals read theme tokens at creation; tell them to re-read.
  window.dispatchEvent(new Event("flipflopper:theme-changed"));
}

function clampZoom(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(num * 100) / 100));
}

export function applyZoom(zoom: number) {
  const level = clampZoom(zoom);
  const style = typeof document !== "undefined" ? document.documentElement?.style : undefined;
  const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (hasTauri) {
    style?.removeProperty?.("zoom");
    void getCurrentWebview().setZoom(level).catch(() => {
      if (style) style.zoom = level === 1 ? "" : String(level);
    });
  } else if (style) {
    style.zoom = level === 1 ? "" : String(level);
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(ZOOM_EVENT));
  }
}

function clampCodeScale(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return CODE_SCALES.reduce((best, step) => (Math.abs(step - num) < Math.abs(best - num) ? step : best), 1 as number);
}

export function applyCodeScale(scale: number) {
  const level = clampCodeScale(scale);
  if (typeof document !== "undefined") document.documentElement?.style?.setProperty?.("--code-scale", String(level));
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(CODE_SCALE_EVENT));
}

/** The reading column shared by the transcript, composer and empty state. */
export function applyChatWidth(width: ChatWidth) {
  const value = width === "full" ? "100%" : width === "wide" ? "clamp(1100px, 94%, 1800px)" : "clamp(920px, 88%, 1440px)";
  if (typeof document !== "undefined") document.documentElement?.style?.setProperty?.("--conversation-max", value);
}

export function setChatWidth(width: ChatWidth) {
  const next: ChatWidth = width === "wide" || width === "full" ? width : "comfortable";
  if (layout.chatWidth === next) return;
  setLayout("chatWidth", next);
  applyChatWidth(next);
  persist();
}

export function setCodeScale(scale: number) {
  const next = clampCodeScale(scale);
  if (layout.codeScale === next) return;
  setLayout("codeScale", next);
  applyCodeScale(next);
  persist();
}

export function stepCodeScale(dir: 1 | -1) {
  const index = CODE_SCALES.indexOf(clampCodeScale(layout.codeScale) as (typeof CODE_SCALES)[number]);
  setCodeScale(CODE_SCALES[Math.min(CODE_SCALES.length - 1, Math.max(0, index + dir))]);
}

/** A stable letter and hue for a project, used as its sidebar badge. */
export interface ProjectIcon {
  /** One or two letters or numbers shown instead of the name's first letter. */
  letter?: string;
  /** Hue (0–359) for the monogram background. */
  hue?: number;
  /** An absolute local image path shown instead of the monogram. */
  image?: string;
}

/** Keep a custom monogram to one or two letters/numbers, a valid hue and a safe image path. */
export function sanitizeProjectIcon(value: unknown): ProjectIcon | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { letter?: unknown; hue?: unknown; image?: unknown };
  const letter = typeof candidate.letter === "string"
    ? [...candidate.letter.trim()].filter((ch) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(ch)).slice(0, 2).join("").toUpperCase()
    : "";
  const hue = typeof candidate.hue === "number" && Number.isFinite(candidate.hue) && candidate.hue >= 0 && candidate.hue < 360
    ? Math.round(candidate.hue)
    : undefined;
  const rawImage = typeof candidate.image === "string" ? candidate.image.trim().slice(0, 2000) : "";
  const image = rawImage && !/[\0\r\n]/.test(rawImage) ? rawImage : "";
  return letter || hue !== undefined || image ? { ...(letter ? { letter } : {}), ...(hue !== undefined ? { hue } : {}), ...(image ? { image } : {}) } : null;
}

export function sanitizeProjectIcons(value: unknown): Record<string, ProjectIcon> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const icons: Record<string, ProjectIcon> = {};
  for (const [path, icon] of Object.entries(value as Record<string, unknown>)) {
    if (!path.trim()) continue;
    const clean = sanitizeProjectIcon(icon);
    if (clean) icons[path] = clean;
  }
  return icons;
}

/** A project's monogram: the saved override, or a letter and hue derived from its name. */
export function projectMonogram(name: string, icon?: ProjectIcon | null): { letter: string; hue: number; image?: string } {
  const clean = name.trim();
  const derived = ([...clean].find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? "?").toUpperCase();
  const custom = sanitizeProjectIcon(icon);
  const letter = custom?.letter || derived;
  let hash = 0;
  for (const ch of clean.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  const hue = custom?.hue ?? hash;
  return { letter, hue, ...(custom?.image ? { image: custom.image } : {}) };
}

// ── Fonts ──

/** A single font family name with only letters, digits, spaces and `. _ -`, or `null` when nothing usable is left. */
export function sanitizeFontFamily(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return clean || null;
}

/** `"Family", <built-in stack>`: the chosen family first, the original fonts as fallback. */
export const fontStack = (family: string | null, fallback: string): string => (family ? `"${family}", ${fallback}` : fallback);

const builtInFonts: { sans?: string; mono?: string } = {};

export function applyFonts() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const style = root?.style;
  if (!style?.setProperty) return;
  if (builtInFonts.sans === undefined) {
    const computed = getComputedStyle(root);
    builtInFonts.sans = computed.getPropertyValue("--font-sans").trim();
    builtInFonts.mono = computed.getPropertyValue("--font-mono").trim();
  }
  const set = (name: string, family: string | null, fallback: string | undefined) => {
    if (family && fallback) style.setProperty(name, fontStack(family, fallback));
    else style.removeProperty(name);
  };
  set("--font-sans", layout.uiFont, builtInFonts.sans);
  set("--font-mono", layout.codeFont, builtInFonts.mono);
  // Open terminals re-read the code font (they share the code-size event).
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CODE_SCALE_EVENT));
}

export function setFonts(next: { uiFont?: string | null; codeFont?: string | null }) {
  if (next.uiFont !== undefined) setLayout("uiFont", sanitizeFontFamily(next.uiFont));
  if (next.codeFont !== undefined) setLayout("codeFont", sanitizeFontFamily(next.codeFont));
  applyFonts();
  persist();
}

// ── Accent color ──

/** `#rgb` / `#rrggbb` (with or without alpha) to lowercase `#rrggbb`, or `null` when it is not a color. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1].slice(0, 6);
  return `#${hex.toLowerCase()}`;
}

const channels = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** Readable text on top of the accent: near-black on light accents, white on dark ones (WCAG relative luminance). */
export function contrastText(hex: string): string {
  const [r, g, b] = channels(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b1411" : "#ffffff";
}

/** The accent token set for a chosen color; dark themes get a lighter "soft" variant for text and borders. */
export function accentTokens(hex: string, scheme: "light" | "dark"): { accent: string; rgb: string; soft: string; onAccent: string } {
  const [r, g, b] = channels(hex);
  const lift = (c: number) => Math.round(c + (255 - c) * 0.28);
  const soft = scheme === "dark" ? `#${[r, g, b].map((c) => lift(c).toString(16).padStart(2, "0")).join("")}` : hex;
  return { accent: hex, rgb: `${r}, ${g}, ${b}`, soft, onAccent: contrastText(hex) };
}

/** Accent color and light/dark hint from a VS Code theme file (JSON with comments). */
export function parseVsCodeAccent(text: string): { accent: string; scheme: "light" | "dark" | null; name: string | null } | null {
  let out = "";
  for (let i = 0, inString = false; i < text.length; i++) {
    const ch = text[i];
    if (inString) { out += ch; if (ch === "\\") out += text[++i] ?? ""; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 1; continue; }
    out += ch;
  }
  try {
    const theme = JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as { colors?: Record<string, unknown>; type?: string; name?: string };
    for (const key of ["button.background", "focusBorder", "textLink.foreground", "activityBarBadge.background", "progressBar.background"]) {
      const accent = normalizeHex(theme.colors?.[key]);
      if (accent) return { accent, scheme: theme.type === "light" ? "light" : theme.type === "dark" ? "dark" : null, name: typeof theme.name === "string" ? theme.name : null };
    }
  } catch { /* not a theme file */ }
  return null;
}

export function applyAccent(accent: string | null) {
  const style = typeof document !== "undefined" ? document.documentElement?.style : undefined;
  if (!style) return;
  // A custom theme owns the accent while it is active; clearing it restores this value.
  if (layout.customTheme) return;
  const names = ["--accent", "--accent-rgb", "--accent-soft", "--fg-on-accent"];
  if (!accent) { names.forEach((name) => style.removeProperty(name)); return; }
  const forced = document.documentElement.getAttribute("data-theme");
  const dark = forced ? forced === "dark" : window.matchMedia?.("(prefers-color-scheme: dark)").matches !== false;
  const tokens = accentTokens(accent, dark ? "dark" : "light");
  style.setProperty("--accent", tokens.accent);
  style.setProperty("--accent-rgb", tokens.rgb);
  style.setProperty("--accent-soft", tokens.soft);
  style.setProperty("--fg-on-accent", tokens.onAccent);
}

export function setAccent(value: string | null) {
  const next = value === null ? null : normalizeHex(value);
  if (value !== null && !next) return false;
  setLayout("accent", next);
  applyAccent(next);
  persist();
  return true;
}

/** Apply inline custom-theme tokens; remove them all when `theme` is null. */
export function applyCustomTheme(theme: CustomTheme | null = layout.customTheme) {
  const root = typeof document !== "undefined" ? document.documentElement : undefined;
  const style = root?.style;
  if (!root || !style) return;
  for (const property of CUSTOM_THEME_PROPERTIES) style.removeProperty(property);
  if (theme) {
    for (const [property, value] of Object.entries(customThemeTokens(theme))) style.setProperty(property, value);
  } else {
    style.removeProperty("color-scheme");
  }
  syncBootTheme();
  window.dispatchEvent(new Event("flipflopper:theme-changed"));
}

/** Save and apply a custom palette, or pass `null` to return to the built-in theme. */
export function setCustomTheme(theme: CustomTheme | null) {
  const clean = theme ? normalizeCustomTheme(theme) : null;
  setLayout("customTheme", clean);
  if (clean) applyCustomTheme(clean);
  else {
    applyCustomTheme(null);
    applyAccent(layout.accent);
  }
  persist();
}

/** "Turn into project": the scratch folder stays where it is and now appears as a regular project. */
export function promoteScratch(path: string) {
  if (layout.promotedScratch.includes(path)) return;
  setLayout("promotedScratch", (list) => [...list, path]);
  persist();
}

export function setWorkingGroup(enabled: boolean) {
  if (layout.workingGroup === enabled) return;
  setLayout("workingGroup", enabled);
  persist();
}

export function setFocusView(enabled: boolean) {
  if (layout.focusView === enabled) return;
  setLayout("focusView", enabled);
  persist();
}

export const toggleFocusView = () => setFocusView(!layout.focusView);

export function setZoomLevel(zoom: number) {
  const next = clampZoom(zoom);
  if (layout.zoom === next) return;
  setLayout("zoom", next);
  applyZoom(next);
  persist();
}

export function stepZoom(dir: 1 | -1) {
  const current = clampZoom(layout.zoom);
  if (dir === 1) {
    const next = ZOOM_STEPS.find((s) => s > current + 0.005) ?? ZOOM_MAX;
    setZoomLevel(next);
  } else {
    let prev: number = ZOOM_MIN;
    for (const s of ZOOM_STEPS) {
      if (s < current - 0.005) prev = s;
      else break;
    }
    setZoomLevel(prev);
  }
}

export function resetZoom() {
  setZoomLevel(1);
}

export async function hydrateLayout() {
  const persisted = await readPref<Partial<LayoutState>>(KEY, {}, () => ({}));
  const saved = persisted && typeof persisted === "object" && !Array.isArray(persisted) ? persisted : {};
  // The terminal used to be a side-pane tab; move that saved state to the footer drawer.
  if ((saved as { sideTab?: string }).sideTab === "terminal") {
    (saved as { sideTab?: string }).sideTab = "changes";
    (saved as { terminalDrawer?: boolean }).terminalDrawer = true;
  }
  const paths = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((p): p is string => typeof p === "string" && !!p))] : [];
  const names = saved.projectNames;
  const projectNames = Object.fromEntries(names && typeof names === "object" && !Array.isArray(names)
    ? Object.entries(names).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim()).map(([path, name]) => [path, name.trim().slice(0, 80)]) : []);
  setLayout({ ...DEFAULTS, ...saved, zoom: clampZoom(saved.zoom), codeScale: clampCodeScale(saved.codeScale), accent: normalizeHex(saved.accent), customTheme: normalizeCustomTheme(saved.customTheme), uiFont: sanitizeFontFamily(saved.uiFont), codeFont: sanitizeFontFamily(saved.codeFont), focusView: saved.focusView === true, workingGroup: saved.workingGroup === true, promotedScratch: paths(saved.promotedScratch), projectNames, projectIcons: sanitizeProjectIcons(saved.projectIcons), sessionOrder: paths(saved.sessionOrder), projectOrder: paths(saved.projectOrder), pinnedProjects: paths(saved.pinnedProjects), hiddenProjects: paths(saved.hiddenProjects) });
  setLayout("sidebarWidth", Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number.isFinite(layout.sidebarWidth) ? layout.sidebarWidth : DEFAULTS.sidebarWidth)));
  setLayout("sideWidth", Math.max(SIDE_MIN, Number.isFinite(layout.sideWidth) ? layout.sideWidth : DEFAULTS.sideWidth));
  if (!["system", "reduced", "off"].includes(layout.motion)) setLayout("motion", "system");
  if (!Number.isFinite(layout.panelMotionMs)) setLayout("panelMotionMs", 240);
  setLayout("panelMotionMs", Math.min(400, Math.max(0, Math.round(layout.panelMotionMs))));
  if (!["comfortable", "wide", "full"].includes(layout.chatWidth)) setLayout("chatWidth", "comfortable");
  if (!Number.isFinite(layout.terminalDrawerHeight)) setLayout("terminalDrawerHeight", 280);
  setLayout("terminalDrawerHeight", Math.min(TERMINAL_DRAWER_MAX, Math.max(TERMINAL_DRAWER_MIN, Math.round(layout.terminalDrawerHeight))));
  applyTheme(layout.theme);
  applyZoom(layout.zoom);
  applyCodeScale(layout.codeScale);
  applyChatWidth(layout.chatWidth);
  applyAccent(layout.accent);
  applyCustomTheme(layout.customTheme);
  applyFonts();
  window.addEventListener("flipflopper:theme-changed", () => applyAccent(layout.accent));
  setMotionReady(true);
  applyMotion();
}

export function toggleSidebar() {
  if (!layout.sidebarOpen && sidebarIsOverlay()) setLayout("sideOpen", false);
  setLayout("sidebarOpen", (v) => !v);
  persist();
}

export function setSidebarWidth(px: number) {
  setLayout("sidebarWidth", Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px))));
  persist();
}

export function setSideWidth(px: number) {
  if (!Number.isFinite(px)) return;
  setLayout("sideWidth", Math.max(SIDE_MIN, Math.round(resolveSidePane(mainWidth(), px).width)));
  persist();
}

const TERMINAL_DRAWER_MIN = 150;
const TERMINAL_DRAWER_MAX = 640;

/** Open the bottom terminal panel (the only terminal surface). */
export function openTerminalDrawer() {
  if (sidebarIsOverlay()) setLayout("sidebarOpen", false);
  setLayout("terminalDrawer", true);
  persist();
}

/** Open or close the bottom terminal drawer. */
export function toggleTerminalDrawer() {
  setLayout("terminalDrawer", (open) => !open);
  persist();
}

export function setTerminalDrawerHeight(px: number) {
  if (!Number.isFinite(px)) return;
  setLayout("terminalDrawerHeight", Math.min(TERMINAL_DRAWER_MAX, Math.max(TERMINAL_DRAWER_MIN, Math.round(px))));
  persist();
}

/** Open the side pane on `tab`; clicking the active tab again closes it. */
export function toggleSide(tab?: SideTab) {
  if (tab && layout.sideOpen && layout.sideTab === tab) {
    setLayout("sideOpen", false);
  } else {
    if (tab) setLayout("sideTab", tab);
    setLayout("sideOpen", tab ? true : !layout.sideOpen);
  }
  if (layout.sideOpen && sidebarIsOverlay()) setLayout("sidebarOpen", false);
  persist();
}

export function openSide(tab: SideTab) {
  if (sidebarIsOverlay()) setLayout("sidebarOpen", false);
  setLayout({ sideOpen: true, sideTab: tab });
  persist();
}

export function setTheme(theme: ThemePref) {
  setLayout("theme", theme);
  applyTheme(theme);
  if (layout.customTheme) applyCustomTheme(layout.customTheme);
  persist();
}

export function setSidebarGroup(group: "project" | "date") {
  setLayout("sidebarGroup", group);
  persist();
}

export function setProjectFilter(path: string | null) {
  setLayout("projectFilter", path);
  persist();
}

/** Persist a manual sidebar order for sessions (ids not listed are treated as new and stay on top). */
export function setSessionOrder(ids: readonly string[]) {
  setLayout("sessionOrder", [...new Set(ids.filter((id) => typeof id === "string" && id))]);
  persist();
}

/** Save or clear a project's monogram override (letter and/or hue). */
export function setProjectIcon(path: string, icon: ProjectIcon | null) {
  const clean = sanitizeProjectIcon(icon);
  setLayout("projectIcons", produce((icons) => {
    if (clean) icons[path] = clean;
    else delete icons[path];
  }));
  persist();
}

export function setProjectDisplayName(path: string, name: string) {
  const label = name.trim().slice(0, 80);
  setLayout("projectNames", produce((names) => {
    if (label) names[path] = label;
    else delete names[path];
  }));
  persist();
}

/** Merge the current display order before moving, retaining hidden projects and
 * paths absent from a search so reordering a filtered list never drops them. */
export function moveSidebarProject(path: string, target: string, position: "before" | "after", available: readonly string[]) {
  if (path === target || !available.includes(path) || !available.includes(target)) return;
  const order = [...new Set([...layout.projectOrder, ...available])].filter((p) => p !== path);
  order.splice(order.indexOf(target) + (position === "after" ? 1 : 0), 0, path);
  setLayout("projectOrder", order);
  persist();
}

/** Pinned projects stay above the rest of the sidebar list. */
export function isProjectPinned(path: string): boolean {
  return (layout.pinnedProjects ?? []).includes(path);
}

export function toggleProjectPin(path: string) {
  setLayout("pinnedProjects", (paths) => (paths ?? []).includes(path) ? (paths ?? []).filter((value) => value !== path) : [...(paths ?? []), path]);
  persist();
}

export function hideSidebarProject(path: string) {
  batch(() => {
    setLayout("hiddenProjects", (paths) => [...new Set([...paths, path])]);
    if (layout.projectFilter === path) setLayout("projectFilter", null);
  });
  persist();
}

export function restoreSidebarProject(path: string) {
  if (!layout.hiddenProjects.includes(path)) return;
  setLayout("hiddenProjects", (paths) => paths.filter((p) => p !== path));
  persist();
}

/** Cycle system → light → dark (the sidebar footer button). */
export function cycleTheme() {
  const order: ThemePref[] = ["system", "light", "dark"];
  setTheme(order[(order.indexOf(layout.theme) + 1) % order.length]);
}
