import { createStore } from "solid-js/store";
import { readPref, writePref } from "./appPrefs";

export type SideTab = "changes" | "preview" | "terminal" | "flow";
export type ThemePref = "system" | "light" | "dark";

interface LayoutState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  sideOpen: boolean;
  sideTab: SideTab;
  sideWidth: number;
  theme: ThemePref;
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
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  // Terminals read theme tokens at creation; tell them to re-read.
  window.dispatchEvent(new Event("flipflopper:theme-changed"));
}

export async function hydrateLayout() {
  const saved = await readPref<Partial<LayoutState>>(KEY, {}, () => ({}));
  setLayout({ ...DEFAULTS, ...saved });
  applyTheme(layout.theme);
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
