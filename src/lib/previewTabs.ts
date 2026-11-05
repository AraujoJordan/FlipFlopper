// State helpers for the Preview browser's tabs. Kept UI-free so the
// close/reopen/history rules can be tested without a DOM.

export type PreviewTabKind = "run" | "user";

export interface PreviewTab {
  id: string;
  url: string | null;
  title: string;
  history: string[];
  index: number;
  reload: number;
  kind: PreviewTabKind;
}

export const previewTabId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `preview-${crypto.randomUUID()}`
    : `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** A short label for a tab: hostname plus a useful path, or "New tab". */
export function previewTabTitle(url: string | null): string {
  if (!url) return "New tab";
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const label = `${parsed.host}${path}`;
    return label.length > 46 ? `${label.slice(0, 45)}…` : label;
  } catch {
    return url.length > 46 ? `${url.slice(0, 45)}…` : url;
  }
}

export function createPreviewTab(url: string | null, kind: PreviewTabKind = "user", id = previewTabId()): PreviewTab {
  return {
    id,
    url,
    title: previewTabTitle(url),
    history: url ? [url] : [],
    index: url ? 0 : -1,
    reload: 0,
    kind,
  };
}

/** Push a URL into a tab's own history, dropping any forward entries. */
export function navigatePreviewTab(tab: PreviewTab, url: string): PreviewTab {
  if (tab.url === url) return tab;
  const history = tab.history.slice(0, tab.index + 1);
  history.push(url);
  return { ...tab, url, title: previewTabTitle(url), history, index: history.length - 1 };
}

/** Move backward (-1) or forward (+1) inside a tab; returns the same tab at an edge. */
export function stepPreviewTab(tab: PreviewTab, delta: 1 | -1): PreviewTab {
  const index = tab.index + delta;
  if (index < 0 || index >= tab.history.length) return tab;
  return { ...tab, index, url: tab.history[index], title: previewTabTitle(tab.history[index]) };
}

/** Close a tab and choose its right neighbour, then its left neighbour. */
export function closePreviewTab(tabs: readonly PreviewTab[], activeId: string | null, id: string): { tabs: PreviewTab[]; activeId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { tabs: [...tabs], activeId };
  const next = tabs[index + 1] ?? tabs[index - 1] ?? null;
  return {
    tabs: tabs.filter((tab) => tab.id !== id),
    activeId: activeId === id ? next?.id ?? null : activeId,
  };
}
