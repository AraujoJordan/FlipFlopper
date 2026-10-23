import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

export type SideTab = "changes" | "preview" | "terminal" | "flow";
export type ThemePref = "system" | "light" | "dark";
export type MotionPref = "system" | "reduced" | "off";
export type ResolvedMotion = "full" | "reduced" | "off";
export const MOTION_EVENT = "flipflopper:motion-changed";
const [motionReady, setMotionReady] = createSignal(false);
const [osReduced, setOsReduced] = createSignal(false);
const [foreground, setForeground] = createSignal(true);
const [overlayPane, setOverlayPane] = createSignal(false);
export const paneIsOverlay = overlayPane;
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
  const narrow = window.matchMedia("(max-width: 1000px)");
  const resized = () => setOverlayPane(narrow.matches);
  const reduced = () => { setOsReduced(media.matches); applyMotion(); };
  const visibility = () => {
    setForeground(!document.hidden);
    document.documentElement.dataset.motionPaused = String(document.hidden);
    if (document.hidden) settleMotion();
    window.dispatchEvent(new Event(MOTION_EVENT));
  };
  reduced(); visibility(); resized();
  media.addEventListener("change", reduced);
  document.addEventListener("visibilitychange", visibility);
  narrow.addEventListener("change", resized);
  return () => { media.removeEventListener("change", reduced); narrow.removeEventListener("change", resized); document.removeEventListener("visibilitychange", visibility); settleMotion(); };
}
export function setMotion(motion: MotionPref) {
  setLayout("motion", motion);
  applyMotion();
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
  /** Sidebar grouping: by project, or by recency. */
  sidebarGroup: "project" | "date";
  /** Project path the sidebar is filtered to, or null for all. */
  projectFilter: string | null;
}

const KEY = "flipflopper:layout";

const DEFAULTS: LayoutState = {
  sidebarOpen: true,
  sidebarWidth: 272,
  sideOpen: false,
  sideTab: "changes",
  sideWidth: 480,
  theme: "system",
  motion: "system",
  sidebarGroup: "project",
  projectFilter: null,
};

export const [layout, setLayout] = createStore<LayoutState>({ ...DEFAULTS });

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 420;
export const SIDE_MIN = 340;

function persist() {
  writePref(KEY, { ...layout });
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
  // Terminals read theme tokens at creation; tell them to re-read.
  window.dispatchEvent(new Event("flipflopper:theme-changed"));
}

export async function hydrateLayout() {
  const saved = await readPref<Partial<LayoutState>>(KEY, {}, () => ({}));
  setLayout({ ...DEFAULTS, ...saved });
  if (!["system", "reduced", "off"].includes(layout.motion)) setLayout("motion", "system");
  applyTheme(layout.theme);
  setMotionReady(true);
  applyMotion();
}

export function toggleSidebar() {
  setLayout("sidebarOpen", (v) => !v);
  persist();
}

export function setSidebarWidth(px: number) {
  setLayout("sidebarWidth", Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px))));
  persist();
}

export function setSideWidth(px: number) {
  const max = Math.max(SIDE_MIN, Math.round(window.innerWidth * 0.7));
  setLayout("sideWidth", Math.min(max, Math.max(SIDE_MIN, Math.round(px))));
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
  persist();
}

export function openSide(tab: SideTab) {
  setLayout({ sideOpen: true, sideTab: tab });
  persist();
}

export function setTheme(theme: ThemePref) {
  setLayout("theme", theme);
  applyTheme(theme);
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

/** Cycle system → light → dark (the sidebar footer button). */
export function cycleTheme() {
  const order: ThemePref[] = ["system", "light", "dark"];
  setTheme(order[(order.indexOf(layout.theme) + 1) % order.length]);
}
