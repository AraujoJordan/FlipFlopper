import { createStore, produce } from "solid-js/store";
import { batch, createSignal } from "solid-js";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readPref, writePref } from "./appPrefs";

export type SideTab = "changes" | "preview" | "terminal" | "flow" | "explain";
export type ThemePref = "system" | "light" | "dark";
export type MotionPref = "system" | "reduced" | "off";
export type ResolvedMotion = "full" | "reduced" | "off";
export const MOTION_EVENT = "flipflopper:motion-changed";
export const ZOOM_EVENT = "flipflopper:zoom-changed";
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.33, 1.5, 1.75, 2.0] as const;
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];
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
  zoom: number;
  /** Sidebar grouping: by project, or by recency. */
  sidebarGroup: "project" | "date";
  /** Project path the sidebar is filtered to, or null for all. */
  projectFilter: string | null;
  projectOrder: string[];
  projectNames: Record<string, string>;
  hiddenProjects: string[];
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
  zoom: 1,
  sidebarGroup: "project",
  projectFilter: null,
  projectOrder: [],
  projectNames: {},
  hiddenProjects: [],
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
  const paths = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((p): p is string => typeof p === "string" && !!p))] : [];
  const names = saved.projectNames;
  const projectNames = Object.fromEntries(names && typeof names === "object" && !Array.isArray(names)
    ? Object.entries(names).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1].trim()).map(([path, name]) => [path, name.trim().slice(0, 80)]) : []);
  setLayout({ ...DEFAULTS, ...saved, zoom: clampZoom(saved.zoom), projectNames, projectOrder: paths(saved.projectOrder), hiddenProjects: paths(saved.hiddenProjects) });
  if (!["system", "reduced", "off"].includes(layout.motion)) setLayout("motion", "system");
  applyTheme(layout.theme);
  applyZoom(layout.zoom);
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
