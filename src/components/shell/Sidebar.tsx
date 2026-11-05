import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  applySessionOrder, archiveSession, archiveSessions, chat, clearSession, deleteSession, forkSession, isRunning, pendingInputCount, navBack, navForward, navState, nestSessions, pinSession, pinSessions, setChat,
  projectName, projectSessionStatus, isScratchSession, regenerateTitle, renameSession, restartAgentSession, selectSession, selectionRange, sessionGroups, sessionProjects, setSettleDisabled, snoozeSession, snoozeSessions, snoozedSessions, startNewSession, startSessionInWorktree,
} from "../../lib/chat";
import { chatTranscriptPath, removeWorktree, type SessionMeta } from "../../lib/ipc";
import { cycleTheme, isProjectPinned, layout, setSessionOrder, setWorkingGroup, sidebarIsOverlay, moveSidebarProject, setProjectDisplayName, setProjectFilter, setSidebarGroup, toggleProjectPin, toggleSidebar } from "../../lib/layout";
import { openProjectPath, removeSidebarProject } from "../../lib/projects";
import { writeClipboardText } from "../../lib/native";
import { store } from "../../lib/store";
import { updateInfo } from "../../lib/updater";
import { openPalette } from "../../lib/palette";
import { modHeld } from "../../lib/shortcuts";
import { promoteScratch } from "../../lib/layout";
import ProjectIconView from "../ProjectIconView";
import { scheduledSessionIds } from "../../lib/schedule";
import { timestampFormat } from "../../lib/settings";
import { compactIdleThreads, confirmations } from "../../lib/settings";
import { openIn, quickEditor } from "../../lib/openIn";
import { setCompareGroup } from "../CompareDialog";
import SessionHoverCard, { hideHoverCard, scheduleHoverCard } from "./SessionHoverCard";
import { AgentLogo } from "../../lib/agentMeta";
import { requestCustomSnooze } from "../SnoozeDialog";
import { openProjectSettings } from "../ProjectSettingsDialog";
import { drafts, removeDraft } from "../../lib/drafts";
import { snoozePresets } from "../../lib/snooze";
import { copyThreadLink } from "../../lib/promptLinks";
import { exportConversation } from "../../lib/exportTranscript";
import { prStatusFor } from "../../lib/prStatus";
import { isManuallyUnread, markManyUnread, markRead, markUnread } from "../../lib/unread";
import { isMuted, setSessionMuted, toggleSessionMuted } from "../../lib/muted";
import { ContextMenu, Menu, MenuDivider, MenuItem, MenuLabel, Spinner, confirmDialog, toast, Disclosure, useListMotion, useSelectionMotion, useValueMotion } from "../ui";
import { Icon } from "./Icon";

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d` : `${Math.round(d / 30)}mo`;
}

/** Sidebar timestamp: relative by default, or an absolute date/time. */
function timeLabel(ts: number): string {
  return timestampFormat() === "absolute"
    ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : ago(ts);
}

const agentIcon = (id: string) => store.agents.find((a) => a.id === id)?.icon ?? null;

function closeOverlaySidebar() {
  if (layout.sidebarOpen && sidebarIsOverlay()) toggleSidebar();
}

function visitSession(id: string) {
  closeOverlaySidebar();
  void selectSession(id);
}

function newConversation(path?: string) {
  closeOverlaySidebar();
  startNewSession(path);
}

const SessionRow: Component<{
  session: SessionMeta;
  depth: number;
  /** Sidebar section that currently owns the row (pinned, working, project, date…). */
  groupKey: string;
  /** Shown when sessions of several projects share a group (date grouping, pinned). */
  projectLabel?: string;
  renaming: boolean;
  selected: boolean;
  dragging: boolean;
  dropPosition: "before" | "after" | null;
  onDragStart: (event: PointerEvent) => void;
  onRenameDone: () => void;
  onActivate: (e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "preventDefault">) => void;
  onContext: (e: MouseEvent) => void;
  /** Keyboard-invoked context menu (Shift+F10 / the Context Menu key). */
  onContextAt: (x: number, y: number) => void;
  onRename: () => void;
  onArchive: () => void;
}> = (props) => {
  const active = () => chat.activeId === props.session.id;
  const running = () => isRunning(props.session.id);
  const attention = () => chat.attention[props.session.id];
  const unread = () => attention() || isManuallyUnread(props.session.id);
  const waiting = () => pendingInputCount(props.session.id) > 0;
  const [draft, setDraft] = createSignal(props.session.title);

  // Holding ⌘/Ctrl shows the ⌘1–⌘9 jump number in place of the age.
  const numberHint = () => {
    if (!modHeld()) return null;
    const index = chat.sessions.filter((s) => !s.archived && !s.hidden).findIndex((s) => s.id === props.session.id);
    return index >= 0 && index < 9 ? `${navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+"}${index + 1}` : null;
  };
  let row: HTMLDivElement | undefined;
  useValueMotion(() => row?.querySelector<HTMLElement>(".session-row-text, .session-row-input") ?? undefined, () => `${props.renaming}:${props.session.title}`);
  const commit = () => {
    void renameSession(props.session.id, draft());
    props.onRenameDone();
  };

  return (
    <div
      ref={row} class="session-row" data-motion-key={props.session.id} data-session-id={props.session.id} data-group-key={props.groupKey}
      onPointerEnter={() => row && scheduleHoverCard(props.session.id, row)}
      onPointerLeave={hideHoverCard}
      onPointerDown={hideHoverCard}
      classList={{ "session-row-active": active(), "session-row-archived": props.session.archived, "session-row-child": props.depth > 0, "session-row-selected": props.selected, "session-row-dragging": props.dragging, "session-row-drop-before": props.dropPosition === "before", "session-row-drop-after": props.dropPosition === "after", "session-row-idle": !running() && !unread() }}
      role="button"
      tabIndex={0}
      aria-pressed={props.selected}
      onClick={(e) => { if (!props.renaming) props.onActivate(e); }}
      onKeyDown={(e) => {
        if (props.renaming) return;
        const rows = () => [...document.querySelectorAll<HTMLElement>(".session-row")];
        const move = (dir: 1 | -1) => {
          const list = rows();
          const next = list[list.indexOf(e.currentTarget as HTMLElement) + dir];
          if (next) { e.preventDefault(); next.focus(); }
        };
        if (e.key === "Enter") props.onActivate(e);
        else if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "F2") { e.preventDefault(); props.onRename(); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); props.onArchive(); }
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          props.onContextAt(rect.left + 14, rect.bottom - 4);
        }
      }}
      onContextMenu={props.onContext}
      aria-label={waiting() ? `${props.session.title} · Needs input` : props.session.title}
    >
      <span class="session-row-drag" aria-hidden="true" title="Drag to reorder, pin or snooze"
        onPointerDown={(event) => { event.stopPropagation(); props.onDragStart(event); }}
        onClick={(event) => event.stopPropagation()}>
        <Icon name="dragHandle" size={12} />
      </span>
      <span class="session-row-lead">
        <Show
          when={running()}
          fallback={<AgentLogo agentId={props.session.agent_id} icon={agentIcon(props.session.agent_id)} size={16} radius={4} />}
        >
          <Show when={waiting()} fallback={<Spinner size={13} />}><Icon name="message" size={14} /></Show>
        </Show>
      </span>
      <Show
        when={props.renaming}
        fallback={
          <span class="session-row-text">
            <span class="session-row-title">{props.session.title || "New session"}</span>
            <Show when={waiting()}><span class="session-row-project">Needs input</span></Show>
            <Show when={props.projectLabel}><span class="session-row-project">{props.projectLabel}</span></Show>
          </span>
        }
      >
        <input
          class="session-row-input"
          value={draft()}
          ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 10)}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") props.onRenameDone();
          }}
          onBlur={commit}
        />
      </Show>
      <Show when={props.session.worktree}>
        <span title={`Worktree ${props.session.worktree!.branch}`} class="session-row-badge"><Icon name="gitBranch" size={11} /></span>
      </Show>
      <Show when={props.session.compare_group}>
        <button type="button" class="session-row-badge" title="Compare the agents started together" aria-label="Compare agents"
          onClick={(e) => { e.stopPropagation(); setCompareGroup(props.session.compare_group!); }}><Icon name="layers" size={11} /></button>
      </Show>
      <Show when={scheduledSessionIds().has(props.session.id)}>
        <span title="Receives scheduled prompts" class="session-row-badge"><Icon name="history" size={11} /></span>
      </Show>
      <Show when={isMuted(props.session.id)}>
        <span title="Notifications muted" class="session-row-badge"><Icon name="notificationsOff" size={11} /></span>
      </Show>
      <Show when={unread() && !active()}><span class="session-dot session-dot-attention" title={attention() ? "Finished" : "Marked unread"} /></Show>
      <Show when={props.session.status === "error" && !running() && !attention()}>
        <span class="session-dot session-dot-error" title="Last turn failed" />
      </Show>
      <span class="session-row-time">{numberHint() ?? timeLabel(props.session.updated_at)}</span>
    </div>
  );
};

const ProjectStatus: Component<{ path: string }> = (props) => {
  const status = () => {
    const value = projectSessionStatus(props.path);
    const manual = chat.sessions.filter((session) => session.project_path === props.path && !session.archived
      && !chat.attention[session.id] && isManuallyUnread(session.id)).length;
    return manual > 0 ? { ...value, unread: value.unread + manual } : value;
  };
  const summary = () => {
    const value = status();
    const parts: string[] = [];
    if (value.waiting) parts.push(`${value.waiting} need${value.waiting === 1 ? "s" : ""} input`);
    const active = Math.max(0, value.running - value.waiting);
    if (active) parts.push(`${active} running`);
    if (value.failed) parts.push(`${value.failed} failed`);
    if (value.unread) parts.push(`${value.unread} finished`);
    if (!parts.length) return value.total ? "Idle" : "No sessions yet";
    return parts.join(" · ");
  };
  const tone = () => {
    const value = status();
    if (value.waiting) return "waiting";
    if (value.failed) return "failed";
    if (value.running) return "running";
    if (value.unread) return "unread";
    return "idle";
  };
  return (
    <Show when={tone() !== "idle"}>
      <span class="project-status" data-tone={tone()} title={summary()}>
        <span class="project-status-dot" />
        <span class="project-status-text">{summary()}</span>
      </span>
    </Show>
  );
};

const Sidebar: Component<{ onOpenSettings: () => void; onOpenProjects: () => void; onOpenUpdate: () => void }> = (props) => {
  const [query, setQuery] = createSignal("");
  const [showArchived, setShowArchived] = createSignal(false);
  const [showSnoozed, setShowSnoozed] = createSignal(false);
  const snoozed = createMemo(() => snoozedSessions());
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<{ x: number; y: number; session: SessionMeta } | null>(null);
  const [projectMenu, setProjectMenu] = createSignal<{ x: number; y: number; path: string } | null>(null);
  const [renamingProject, setRenamingProject] = createSignal<string | null>(null);
  const [projectDraft, setProjectDraft] = createSignal("");
  const [drag, setDrag] = createSignal<{ path: string; x: number; y: number } | null>(null);
  const [drop, setDrop] = createSignal<{ path: string; position: "before" | "after" } | null>(null);
  const [sessionDrag, setSessionDrag] = createSignal<{ id: string; x: number; y: number; fromKey: string } | null>(null);
  const [sessionDrop, setSessionDrop] = createSignal<{ id: string; position: "before" | "after" | "on"; groupKey: string } | null>(null);
  // Multi-select: ⌘/Ctrl-click toggles a row, Shift-click extends from the anchor.
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = createSignal<string | null>(null);
  const [bulkMenu, setBulkMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = createSignal(false);
  let snoozeButton: HTMLButtonElement | undefined;
  let stopDragging: (() => void) | undefined;
  let stopSessionDragging: (() => void) | undefined;
  let suppressClick = false;
  let clickReset: ReturnType<typeof setTimeout> | undefined;

  const groups = createMemo(() =>
    sessionGroups({ includeArchived: showArchived(), query: query(), group: layout.sidebarGroup, filter: layout.projectFilter }),
  );
  const projects = createMemo(sessionProjects);
  const visibleDrafts = createMemo(() => drafts().filter((draft) => draft.key === "new" || chat.sessions.some((session) => session.id === draft.key)));
  const orderedIds = createMemo(() => [
    ...groups().flatMap((group) => group.sessions.map((session) => session.id)),
    ...(showSnoozed() ? snoozed().map((session) => session.id) : []),
  ]);
  const selectedCount = () => selectedIds().size;
  const selectedSessions = () => {
    const ids = selectedIds();
    return chat.sessions.filter((session) => ids.has(session.id));
  };
  const allSelectedPinned = () => selectedSessions().every((session) => session.pinned);
  const isSelected = (id: string) => selectedIds().has(id);
  function clearSelection() {
    if (selectedIds().size === 0 && selectionAnchor() === null) return;
    setSelectedIds(new Set<string>());
    setSelectionAnchor(null);
  }
  function toggleSelected(id: string) {
    const next = new Set(selectedIds());
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
    setSelectionAnchor(next.size > 0 ? id : null);
  }
  function extendSelection(id: string) {
    setSelectedIds(new Set(selectionRange(orderedIds(), selectionAnchor(), id)));
    if (!selectionAnchor()) setSelectionAnchor(id);
  }
  function activateRow(session: SessionMeta, event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "preventDefault">) {
    const mac = navigator.platform.toLowerCase().includes("mac");
    if (mac ? event.metaKey : event.ctrlKey) { event.preventDefault(); toggleSelected(session.id); return; }
    if (event.shiftKey) { event.preventDefault(); extendSelection(session.id); return; }
    if (selectedIds().size > 0) clearSelection();
    visitSession(session.id);
  }
  /** Visible order inside the group that holds `id`, following the manual order. */
  const idsInGroup = (id: string): string[] => {
    const group = groups().find((candidate) => candidate.sessions.some((session) => session.id === id));
    return group ? applySessionOrder(group.sessions, layout.sessionOrder ?? []).map((session) => session.id) : [];
  };
  const canMoveSession = (id: string, dir: -1 | 1) => {
    const ids = idsInGroup(id);
    const at = ids.indexOf(id);
    return at >= 0 && at + dir >= 0 && at + dir < ids.length;
  };
  /** Swap this session with its visible neighbour and save the resulting global order. */
  function moveSession(id: string, dir: -1 | 1) {
    const ids = idsInGroup(id);
    const at = ids.indexOf(id);
    const target = ids[at + dir];
    if (!target) return;
    const all = groups().flatMap((group) => applySessionOrder(group.sessions, layout.sessionOrder ?? []).map((session) => session.id));
    const from = all.indexOf(id);
    const to = all.indexOf(target);
    if (from < 0 || to < 0) return;
    const next = [...all];
    next.splice(from, 1);
    next.splice(to, 0, id);
    setSessionOrder(next);
  }

  function showRowMenu(session: SessionMeta, x: number, y: number) {
    setProjectMenu(null);
    if (isSelected(session.id) && selectedCount() > 1) { setMenu(null); setBulkMenu({ x, y }); return; }
    setBulkMenu(null);
    setMenu({ x, y, session });
  }
  async function bulkPin(pinned: boolean) {
    const ids = [...selectedIds()];
    if (!ids.length) return;
    if (!pinned && confirmations().unpin && !(await confirmDialog(`Unpin ${ids.length} session${ids.length === 1 ? "" : "s"}?`, "Unpin"))) return;
    void pinSessions(ids, pinned).then((changed) => { if (changed > 0) clearSelection(); });
  }
  async function archiveWithConfirmation(ids: string[]) {
    if (!ids.length) return;
    if (confirmations().archive && !(await confirmDialog(`Archive ${ids.length === 1 ? "this session" : `${ids.length} sessions`}? You can restore ${ids.length === 1 ? "it" : "them"} from the archive.`, "Archive"))) return;
    await archiveSessions(ids, true);
  }
  async function pinWithConfirmation(id: string, pinned: boolean) {
    if (!pinned && confirmations().unpin && !(await confirmDialog("Unpin this session?", "Unpin"))) return;
    await pinSession(id, pinned);
  }
  async function bulkArchive() {
    const ids = [...selectedIds()];
    if (!ids.length) return;
    if (confirmations().archive && !(await confirmDialog(`Archive ${ids.length === 1 ? "this session" : `${ids.length} sessions`}? You can restore ${ids.length === 1 ? "it" : "them"} from the archive.`, "Archive"))) return;
    clearSelection();
    await archiveSessions(ids, true);
  }
  function bulkSnooze() {
    const ids = [...selectedIds()];
    const title = ids.length === 1 ? selectedSessions()[0]?.title : undefined;
    setSnoozeMenuOpen(false);
    requestCustomSnooze(ids, title);
  }
  function bulkSnoozeUntil(until: number) {
    const ids = [...selectedIds()];
    setSnoozeMenuOpen(false);
    void snoozeSessions(ids, until).then((changed) => { if (changed > 0) clearSelection(); });
  }
  async function bulkRegenerateTitles() {
    const ids = [...selectedIds()];
    if (!ids.length) return;
    setBulkMenu(null);
    let changed = 0;
    for (const id of ids) {
      try { await regenerateTitle(id); changed += 1; } catch { /* keep going for the rest */ }
    }
    clearSelection();
    toast(changed === ids.length ? `Regenerated ${changed} title${changed === 1 ? "" : "s"}` : `Regenerated ${changed} of ${ids.length} titles`, changed ? "success" : "error");
  }
  // A selection can outlive the rows it points at (search, archive, project switch).
  createEffect(() => {
    const visible = new Set(orderedIds());
    const current = selectedIds();
    const kept = [...current].filter((id) => visible.has(id));
    if (kept.length !== current.size) {
      setSelectedIds(new Set(kept));
      setSelectionAnchor((anchor) => anchor && kept.includes(anchor) ? anchor : null);
    }
  });
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (selectedIds().size === 0) return;
      // Dialogs and menus own Escape while they are open.
      if (document.querySelector('.motion-menu, [role="dialog"]')) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); clearSelection(); return; }
      const mac = navigator.platform.toLowerCase().includes("mac");
      const editable = (document.activeElement as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable='true']");
      if ((mac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "a" && !editable && sidebar?.contains(document.activeElement)) {
        event.preventDefault();
        setSelectedIds(new Set(orderedIds()));
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  const projectSuffix = (path: string, name: string) => {
    const peers = projects().filter((p) => p.path !== path && p.name === name);
    if (!peers.length) return "";
    const parent = (value: string) => value.replace(/\\/g, "/").split("/").filter(Boolean).slice(0, -1);
    const parts = parent(path);
    let count = Math.min(2, parts.length);
    while (count < parts.length && peers.some((p) => parent(p.path).slice(-count).join("/") === parts.slice(-count).join("/"))) count++;
    return `${count < parts.length ? "…/" : "/"}${parts.slice(-count).join("/")}`;
  };
  const [filterOpen, setFilterOpen] = createSignal(false);
  let filterAnchor: HTMLButtonElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  const filterLabel = () => projects().find((p) => p.path === layout.projectFilter)?.name ?? "All projects";
  const themeIcon = () => (layout.theme === "dark" ? "sparkle" : layout.theme === "light" ? "eye" : "settings") as "sparkle" | "eye" | "settings";
  const archivedCount = () => chat.sessions.filter((s) => s.archived).length;
  let sidebar: HTMLElement | undefined;
  let themeButton: HTMLButtonElement | undefined;
  useListMotion(() => sidebar, () => groups().map((g) => `${g.key}:${g.sessions.map((s) => s.id).join()}`).join("|"), ".session-group-head, .session-row");
  useSelectionMotion(() => sidebar, () => chat.activeId, ".session-row-active");
  useValueMotion(() => themeButton, () => layout.theme, true);

  const projectPaths = () => projects().map((p) => p.path);
  const projectIndex = (path: string) => projectPaths().indexOf(path);
  const focusProject = (path: string) => queueMicrotask(() => sidebar?.querySelector<HTMLElement>(`[data-project-path="${CSS.escape(path)}"] .session-group-toggle`)?.focus({ preventScroll: true }));
  const moveProject = (path: string, direction: -1 | 1) => {
    const target = projectPaths()[projectIndex(path) + direction];
    if (target) { moveSidebarProject(path, target, direction < 0 ? "before" : "after", projectPaths()); focusProject(path); }
  };
  const renameProject = (path: string) => {
    setProjectDraft(projectName(path)); setRenamingProject(path); setProjectMenu(null);
  };
  const commitProjectName = (path: string) => {
    if (renamingProject() !== path) return;
    const name = projectDraft().trim();
    if (name) setProjectDisplayName(path, name);
    setRenamingProject(null); focusProject(path);
  };
  const showProjectMenu = (event: MouseEvent, path: string) => {
    event.preventDefault(); event.stopPropagation();
    setMenu(null); setProjectMenu({ x: event.clientX, y: event.clientY, path });
  };

  // Pointer capture works inside Tauri's native file-drop surface, including on
  // WebKit where native HTML drag/drop can be intercepted by the desktop shell.
  function beginProjectDrag(event: PointerEvent, path: string) {
    if (event.button !== 0 || renamingProject() || projectPaths().length < 2) return;
    stopDragging?.();
    clearTimeout(clickReset); suppressClick = false;
    const handle = event.currentTarget as HTMLElement;
    const pointer = event.pointerId, startX = event.clientX, startY = event.clientY;
    let active = false;
    handle.setPointerCapture(pointer);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      if (!active && Math.hypot(next.clientX - startX, next.clientY - startY) < 5) return;
      active = true; suppressClick = true;
      setProjectMenu(null); setDrag({ path, x: next.clientX, y: next.clientY });
      const scroll = sidebar?.querySelector<HTMLElement>(".sidebar-scroll");
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        if (next.clientY < bounds.top + 32) scroll.scrollTop -= 14;
        if (next.clientY > bounds.bottom - 32) scroll.scrollTop += 14;
      }
      const target = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>("[data-project-path]");
      const targetPath = target?.dataset.projectPath;
      if (!target || !sidebar?.contains(target) || !targetPath || targetPath === path) { setDrop(null); return; }
      const bounds = target.getBoundingClientRect();
      setDrop({ path: targetPath, position: next.clientY < bounds.top + bounds.height / 2 ? "before" : "after" });
      next.preventDefault();
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", cancel, true);
      handle.removeEventListener("lostpointercapture", cancel);
      document.removeEventListener("keydown", escape, true);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      setDrag(null); setDrop(null); stopDragging = undefined;
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      const destination = drop();
      cleanup();
      if (active && destination) {
        moveSidebarProject(path, destination.path, destination.position, projectPaths()); focusProject(path);
      }
      // The synthesized click follows pointerup; a later keyboard/click action
      // must still be able to expand the project normally.
      clickReset = setTimeout(() => { suppressClick = false; }, 0);
    };
    const cancel = (event?: PointerEvent) => { if (event && event.pointerId !== pointer) return; cleanup(); suppressClick = false; };
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); key.stopPropagation(); cancel(); } };
    stopDragging = cancel;
    // A release can be retargeted by the WebView/native drag surface. Capture
    // it at the document as well as retaining pointer capture on the handle.
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", cancel, true);
    handle.addEventListener("lostpointercapture", cancel);
    document.addEventListener("keydown", escape, true);
  }

  /** Drag a session row by its handle to reorder it, move it into the pinned
   *  section, wake it from Snoozed, or park it there for an hour. */
  function beginSessionDrag(event: PointerEvent, session: SessionMeta, fromKey: string) {
    if (event.button !== 0) return;
    stopSessionDragging?.();
    clearTimeout(clickReset); suppressClick = false;
    const handle = event.currentTarget as HTMLElement;
    const pointer = event.pointerId, startX = event.clientX, startY = event.clientY;
    let active = false;
    handle.setPointerCapture(pointer);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      if (!active && Math.hypot(next.clientX - startX, next.clientY - startY) < 5) return;
      active = true; suppressClick = true;
      setMenu(null); setBulkMenu(null); setProjectMenu(null);
      setSessionDrag({ id: session.id, x: next.clientX, y: next.clientY, fromKey });
      const scroll = sidebar?.querySelector<HTMLElement>(".sidebar-scroll");
      if (scroll) {
        const bounds = scroll.getBoundingClientRect();
        if (next.clientY < bounds.top + 32) scroll.scrollTop -= 14;
        if (next.clientY > bounds.bottom - 32) scroll.scrollTop += 14;
      }
      const hit = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>("[data-session-id], [data-session-group-key]");
      if (!hit || !sidebar?.contains(hit)) { setSessionDrop(null); return; }
      if (hit.dataset.sessionId) {
        if (hit.dataset.sessionId === session.id) { setSessionDrop(null); return; }
        const bounds = hit.getBoundingClientRect();
        setSessionDrop({
          id: hit.dataset.sessionId,
          groupKey: hit.dataset.groupKey ?? fromKey,
          position: next.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
        });
      } else if (hit.dataset.sessionGroupKey) {
        setSessionDrop({ id: "", groupKey: hit.dataset.sessionGroupKey, position: "on" });
      }
      next.preventDefault();
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", cancel, true);
      handle.removeEventListener("lostpointercapture", cancel);
      document.removeEventListener("keydown", escape, true);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      setSessionDrag(null); setSessionDrop(null); stopSessionDragging = undefined;
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      const destination = sessionDrop();
      cleanup();
      if (active && destination) void dropSession(session, fromKey, destination);
      clickReset = setTimeout(() => { suppressClick = false; }, 0);
    };
    const cancel = (event?: PointerEvent) => { if (event && event.pointerId !== pointer) return; cleanup(); suppressClick = false; };
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); key.stopPropagation(); cancel(); } };
    stopSessionDragging = cancel;
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", cancel, true);
    handle.addEventListener("lostpointercapture", cancel);
    document.addEventListener("keydown", escape, true);
  }

  async function dropSession(
    session: SessionMeta,
    fromKey: string,
    target: { id: string; position: "before" | "after" | "on"; groupKey: string },
  ) {
    if (target.groupKey === "snoozed") {
      if (fromKey !== "snoozed") {
        await snoozeSession(session.id, Date.now() + 3_600_000);
        toast("Snoozed for 1 hour", "info");
      }
      return;
    }
    // Dropping out of the Snoozed shelf wakes the session before it joins a section.
    if (fromKey === "snoozed") await snoozeSession(session.id, null);
    const pinned = target.groupKey === "pinned";
    if (session.pinned !== pinned) await pinSession(session.id, pinned);
    if (!target.id) return;
    const all = groups().flatMap((group) =>
      applySessionOrder(group.sessions, layout.sessionOrder ?? []).map((entry) => entry.id),
    );
    if (!all.includes(session.id)) all.push(session.id);
    const from = all.indexOf(session.id);
    if (from >= 0) all.splice(from, 1);
    const at = all.indexOf(target.id);
    if (at < 0) all.push(session.id);
    else all.splice(at + (target.position === "after" ? 1 : 0), 0, session.id);
    setSessionOrder(all);
  }

  createEffect(() => { if (layout.sidebarGroup !== "project") stopDragging?.(); });
  onCleanup(() => { stopDragging?.(); stopSessionDragging?.(); clearTimeout(clickReset); });
  async function confirmDelete(session: SessionMeta) {
    if (confirmations().delete && !(await confirmDialog(`Delete “${session.title || "this session"}”? The conversation can't be recovered.`, "Delete"))) return;
    const wt = session.worktree;
    await deleteSession(session.id);
    if (wt) {
      const drop = await confirmDialog(
        `This session ran in worktree ${wt.branch}. Remove the worktree and its branch too? Unmerged changes there will be lost.`,
        "Remove worktree",
      );
      if (drop) {
        try {
          await removeWorktree(session.project_path, wt.path, wt.branch, true);
        } catch (e) {
          toast(`Couldn't remove worktree: ${String(e)}`, "error");
        }
      }
    }
  }

  return (
    <aside ref={sidebar} class="sidebar" data-focus-area="sidebar" classList={{ "sidebar-compact-idle": compactIdleThreads() }}>
      <div class="native-window-space" data-window-header aria-hidden="true" />
      <div class="sidebar-top">
        <div class="sidebar-top-actions">
          <button class="icon-btn sidebar-toggle" onClick={toggleSidebar} title="Hide sidebar (⌘B)" aria-label="Hide sidebar">
            <Icon name="sidebar" size={16} />
          </button>
          <button class="icon-btn" onClick={navBack} disabled={!navState().back} title="Back (⌘[)" aria-label="Back">
            <Icon name="chevronRight" size={15} style={{ transform: "rotate(180deg)" }} />
          </button>
          <button class="icon-btn" onClick={navForward} disabled={!navState().forward} title="Forward (⌘])" aria-label="Forward">
            <Icon name="chevronRight" size={15} />
          </button>
        </div>
        <button class="new-session-btn" onClick={() => newConversation()} title="New session (⌘N)" aria-label="New session">
          <Icon name="plus" size={14} />
          <span>New</span>
          <kbd>⌘N</kbd>
        </button>
      </div>

      <div class="sidebar-search-row">
        <div class="sidebar-search">
          <Icon name="search" size={14} />
          <input
            ref={searchInput}
            placeholder="Search sessions and projects"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query()) { e.stopPropagation(); setQuery(""); } }}
            spellcheck={false}
          />
          <Show when={query()}>
            <button class="icon-btn" onClick={() => setQuery("")} aria-label="Clear search"><Icon name="x" size={12} /></button>
          </Show>
        </div>
        <button
          ref={filterAnchor}
          class="filter-pill"
          classList={{ "filter-pill-active": !!layout.projectFilter || layout.sidebarGroup !== "project" || showArchived() || showSnoozed() || layout.workingGroup }}
          onClick={() => setFilterOpen((v) => !v)}
          title={`View: ${layout.projectFilter ? filterLabel() : layout.sidebarGroup === "project" ? "Projects" : "Recent sessions"}`}
          aria-label="Session view options"
          aria-haspopup="menu"
          aria-expanded={filterOpen()}
        >
          <Icon name="list" size={14} />
          <Show when={layout.projectFilter}>
            <span class="filter-pill-label">{filterLabel()}</span>
          </Show>
          <Icon name="chevronDown" size={11} />
        </button>
        <Show when={layout.projectFilter}>
          <button class="icon-btn" aria-label="Clear project filter" title="Show all projects" onClick={() => setProjectFilter(null)}>
            <Icon name="x" size={13} />
          </button>
        </Show>
        <Menu open={filterOpen()} onClose={() => setFilterOpen(false)} anchorRef={filterAnchor} align="right" width={240}>
          <MenuLabel>Group sessions by</MenuLabel>
          <For each={["project", "date"] as const}>{(group) => (
            <MenuItem onSelect={() => { setSidebarGroup(group); setFilterOpen(false); }}>
              <span style={{ flex: 1 }}>{group === "project" ? "Project" : "Date"}</span><Show when={layout.sidebarGroup === group}><Icon name="check" size={14} /></Show>
            </MenuItem>
          )}</For>
          <MenuDivider />
          <MenuItem onSelect={() => { setCollapsed(Object.fromEntries(groups().map((group) => [group.key, true]))); setFilterOpen(false); }}>
            <Icon name="list" size={14} /> <span style={{ flex: 1 }}>Collapse all</span>
          </MenuItem>
          <MenuItem onSelect={() => { setCollapsed({}); setFilterOpen(false); }}>
            <Icon name="list" size={14} /> <span style={{ flex: 1 }}>Expand all</span>
          </MenuItem>
          <MenuItem onSelect={() => { setShowArchived((value) => !value); setFilterOpen(false); }}>
            <Icon name="archive" size={14} /> <span style={{ flex: 1 }}>Show archived sessions</span>
            <Show when={showArchived()}><Icon name="check" size={14} /></Show>
          </MenuItem>
          <MenuItem onSelect={() => { setShowSnoozed((value) => !value); setFilterOpen(false); }}>
            <Icon name="history" size={14} /> <span style={{ flex: 1 }}>Show snoozed sessions</span>
            <Show when={showSnoozed()}><Icon name="check" size={14} /></Show>
          </MenuItem>
          <MenuItem onSelect={() => { setWorkingGroup(!layout.workingGroup); setFilterOpen(false); }}>
            <Icon name="refresh" size={14} /> <span style={{ flex: 1 }}>Working group</span>
            <Show when={layout.workingGroup}><Icon name="check" size={14} /></Show>
          </MenuItem>
          <MenuDivider />
          <MenuLabel>Show sessions from</MenuLabel>
          <MenuItem onSelect={() => { setProjectFilter(null); setFilterOpen(false); }}>
            <span style={{ flex: 1 }}>All projects</span>
            <Show when={!layout.projectFilter}><Icon name="check" size={14} /></Show>
          </MenuItem>
          <For each={projects()}>
            {(p) => (
              <MenuItem onSelect={() => { setProjectFilter(p.path); setFilterOpen(false); }}>
                <Icon name="folder" size={14} />
                <span class="project-menu-name">{p.name}<Show when={projectSuffix(p.path, p.name)}>{(suffix) => <small title={p.path}>{suffix()}</small>}</Show></span>
                <Show when={layout.projectFilter === p.path}><Icon name="check" size={14} /></Show>
              </MenuItem>
            )}
          </For>
        </Menu>
      </div>

      <Show when={selectedCount() > 0}>
        <div class="session-selection-bar" role="toolbar" aria-label="Selected sessions">
          <span class="session-selection-count">{selectedCount()} selected</span>
          <div class="session-selection-actions">
            <button type="button" class="icon-btn" title={allSelectedPinned() ? "Unpin selected" : "Pin selected"} aria-label={allSelectedPinned() ? "Unpin selected" : "Pin selected"} onClick={() => bulkPin(!allSelectedPinned())}>
              <Icon name="sparkle" size={14} />
            </button>
            <button ref={snoozeButton} type="button" class="icon-btn" title="Snooze selected…" aria-label="Snooze selected" aria-haspopup="menu" aria-expanded={snoozeMenuOpen()} onClick={() => setSnoozeMenuOpen((open) => !open)}>
              <Icon name="history" size={14} />
            </button>
            <button type="button" class="icon-btn" title="Archive selected" aria-label="Archive selected" onClick={bulkArchive}>
              <Icon name="archive" size={14} />
            </button>
            <Show when={selectedCount() === 1}>
              <button type="button" class="icon-btn" title="Session options" aria-label="Session options" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const only = selectedSessions()[0]; if (only) showRowMenu(only, rect.left, rect.bottom); }}>
                <Icon name="more" size={14} />
              </button>
            </Show>
            <button type="button" class="icon-btn" title="Select all visible sessions" aria-label="Select all visible sessions" onClick={() => setSelectedIds(new Set(orderedIds()))}>
              <Icon name="list" size={14} />
            </button>
            <button type="button" class="icon-btn" title="Clear selection (Esc)" aria-label="Clear selection" onClick={clearSelection}>
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      </Show>
      <Menu open={snoozeMenuOpen()} onClose={() => setSnoozeMenuOpen(false)} anchorRef={snoozeButton} width={232}>
        <MenuLabel>Snooze {selectedCount()} session{selectedCount() === 1 ? "" : "s"}</MenuLabel>
        <For each={snoozePresets(new Date())}>
          {(preset) => (
            <MenuItem onSelect={() => bulkSnoozeUntil(preset.until)}>
              <Icon name="history" size={14} /> {preset.label}
            </MenuItem>
          )}
        </For>
        <MenuDivider />
        <MenuItem onSelect={bulkSnooze}>
          <Icon name="history" size={14} /> Custom…
        </MenuItem>
      </Menu>

      <div class="sidebar-scroll">
        <Show when={visibleDrafts().length > 0}>
          <div class="sidebar-drafts">
            <div class="session-group-label">Drafts</div>
            <For each={visibleDrafts()}>
              {(draft) => {
                const session = () => chat.sessions.find((entry) => entry.id === draft.key);
                const active = () => draft.key === (chat.activeId ?? "new");
                const open = () => { if (draft.key === "new") newConversation(draft.project_path ?? undefined); else visitSession(draft.key); };
                const discard = () => {
                  removeDraft(draft.key);
                  window.dispatchEvent(new CustomEvent("flipflopper:draft-discarded", { detail: draft.key }));
                };
                return (
                  <div class="sidebar-draft" classList={{ "sidebar-draft-active": active() }} role="button" tabIndex={0}
                    title={draft.text || `${draft.attachments.length} attachment${draft.attachments.length === 1 ? "" : "s"}`}
                    onClick={open}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); open(); }
                      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); discard(); }
                    }}>
                    <Icon name="pencil" size={12} />
                    <span class="sidebar-draft-copy">
                      <span class="sidebar-draft-text">{draft.text.trim().split("\n")[0] || `${draft.attachments.length} attachment${draft.attachments.length === 1 ? "" : "s"}`}</span>
                      <span class="sidebar-draft-meta">
                        {projectName(draft.project_path ?? session()?.project_path ?? "") || "No project"}
                        {" · "}{timeLabel(draft.updated_at)}
                        <Show when={draft.attachments.length > 0}>{` · ${draft.attachments.length} file${draft.attachments.length === 1 ? "" : "s"}`}</Show>
                      </span>
                    </span>
                    <button type="button" class="icon-btn sidebar-draft-discard" title="Discard draft" aria-label="Discard draft"
                      onClick={(event) => { event.stopPropagation(); discard(); }}>
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
        <Show
          when={groups().length > 0}
          fallback={
            <div class="sidebar-empty">
              {query() ? "No matching sessions." : "No sessions yet. Start one and it will show up here."}
            </div>
          }
        >
          <For each={groups()}>
            {(group) => (
              <section class="session-group" data-project-path={group.projectPath} data-session-group-key={group.key}
                classList={{ "session-group-active": chat.sessions.find((session) => session.id === chat.activeId)?.project_path === group.projectPath, "project-dragging": drag()?.path === group.projectPath && !!group.projectPath, "project-drop-before": drop()?.path === group.projectPath && drop()?.position === "before", "project-drop-after": drop()?.path === group.projectPath && drop()?.position === "after", "session-group-drop": sessionDrop()?.groupKey === group.key && sessionDrop()?.position === "on" }}>
                <div class="session-group-head" data-motion-key={`group:${group.key}`}
                  onContextMenu={(event) => { if (group.projectPath) showProjectMenu(event, group.projectPath); }}>
                  <Show when={renamingProject() === group.projectPath && !!group.projectPath} fallback={
                  <button
                    class="session-group-toggle"
                    onClick={() => { if (!suppressClick) setCollapsed((c) => ({ ...c, [group.key]: !c[group.key] })); }}
                    onPointerDown={(event) => { if (group.projectPath) beginProjectDrag(event, group.projectPath); }}
                    onKeyDown={(event) => {
                      const path = group.projectPath;
                      if (!path) return;
                      if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); moveProject(path, event.key === "ArrowUp" ? -1 : 1); }
                      if (event.key === "F2") { event.preventDefault(); renameProject(path); }
                      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setProjectMenu({path,x:rect.left,y:rect.bottom}); }
                    }}
                    aria-expanded={!collapsed()[group.key]}
                    title={group.projectPath ?? group.label}
                  >
                    <Icon
                      name="chevronRight"
                      size={12}
                      style={{ transform: collapsed()[group.key] ? "none" : "rotate(90deg)", transition: "transform var(--dur-fast)" }}
                    />
                    <Show when={group.projectPath} fallback={<Icon name={group.key === "pinned" ? "sparkle" : group.key === "working" ? "refresh" : group.key === "scratch" ? "document" : "history"} size={14} />}>
                      <ProjectIconView name={group.label} icon={group.projectPath ? layout.projectIcons[group.projectPath] : null} path={group.projectPath} />
                    </Show>
                    <span class="session-group-copy">
                      <span class="session-group-name">
                        <Show when={group.projectPath && isProjectPinned(group.projectPath)}><Icon name="sparkle" size={11} /></Show>
                        {group.label}
                        <Show when={group.projectPath && projectSuffix(group.projectPath, group.label)}>{(suffix) => <small>{suffix()}</small>}</Show>
                        <Show when={group.sessions.length > 0}><span class="session-group-count">{group.sessions.length}</span></Show>
                      </span>
                      <Show when={group.projectPath}>{(path) => <ProjectStatus path={path()} />}</Show>
                    </span>
                  </button>
                  }>
                    <input class="session-row-input project-name-input" aria-label="Project display name" maxLength={80} value={projectDraft()}
                      ref={(input) => queueMicrotask(() => { if (input.isConnected) { input.focus(); input.select(); } })}
                      onInput={(event) => setProjectDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") { event.preventDefault(); commitProjectName(group.projectPath!); }
                        if (event.key === "Escape") { event.preventDefault(); setRenamingProject(null); focusProject(group.projectPath!); }
                      }} onBlur={() => commitProjectName(group.projectPath!)} />
                  </Show>
                  <Show when={group.projectPath}>
                    <button type="button" class="icon-btn project-drag-handle" title="Drag to reorder · Alt+↑/↓ to move" aria-label={`Reorder ${group.label}`}
                      onPointerDown={(event) => beginProjectDrag(event, group.projectPath!)}
                      onKeyDown={(event) => { if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); moveProject(group.projectPath!, event.key === "ArrowUp" ? -1 : 1); } }}>
                      <Icon name="dragHandle" size={13} />
                    </button>
                    <button type="button" class="icon-btn session-group-add" title={`Options for ${group.label}`} aria-label={`Options for ${group.label}`}
                      onClick={(event) => { const rect=event.currentTarget.getBoundingClientRect(); setMenu(null); setProjectMenu({path:group.projectPath!,x:rect.left,y:rect.bottom}); }}><Icon name="more" size={14} /></button>
                    <button
                      class="icon-btn session-group-add"
                      onClick={() => newConversation(group.projectPath)}
                      title={`New session in ${group.label}`}
                      aria-label={`New session in ${group.label}`}
                    >
                      <Icon name="plus" size={13} />
                    </button>
                  </Show>
                </div>
                <Disclosure open={!collapsed()[group.key]}>
                  <For each={nestSessions(group.sessions)}>
                    {({ session, depth }) => (
                      <SessionRow
                        session={session}
                        depth={depth}
                        groupKey={group.key}
                        projectLabel={group.projectPath ? undefined : projectName(session.project_path)}
                        renaming={renamingId() === session.id}
                        selected={isSelected(session.id)}
                        dragging={sessionDrag()?.id === session.id}
                        dropPosition={sessionDrop()?.id === session.id ? (sessionDrop()!.position === "before" ? "before" : "after") : null}
                        onDragStart={(event) => beginSessionDrag(event, session, group.key)}
                        onRenameDone={() => setRenamingId(null)}
                        onActivate={(e) => activateRow(session, e)}
                        onContext={(e) => { e.preventDefault(); showRowMenu(session, e.clientX, e.clientY); }}
                        onContextAt={(x, y) => showRowMenu(session, x, y)}
                        onRename={() => setRenamingId(session.id)}
                        onArchive={() => session.archived ? void archiveSession(session.id, false) : void archiveWithConfirmation([session.id])}
                      />
                    )}
                  </For>
                </Disclosure>
              </section>
            )}
          </For>
        </Show>

        <Show when={snoozed().length > 0}>
          <button class="sidebar-archived-toggle" data-session-group-key="snoozed" classList={{ "session-group-drop": sessionDrop()?.groupKey === "snoozed" }} onClick={() => setShowSnoozed((v) => !v)}>
            <Icon name="history" size={13} />
            {showSnoozed() ? "Hide snoozed" : `Snoozed (${snoozed().length})`}
          </button>
          <Show when={showSnoozed()}>
            <For each={snoozed()}>
              {(session) => (
                <SessionRow
                  session={session}
                  depth={0}
                  groupKey="snoozed"
                  projectLabel={projectName(session.project_path)}
                  renaming={renamingId() === session.id}
                  selected={isSelected(session.id)}
                  dragging={sessionDrag()?.id === session.id}
                  dropPosition={sessionDrop()?.id === session.id ? (sessionDrop()!.position === "before" ? "before" : "after") : null}
                  onDragStart={(event) => beginSessionDrag(event, session, "snoozed")}
                  onRenameDone={() => setRenamingId(null)}
                  onActivate={(e) => activateRow(session, e)}
                  onContext={(e) => { e.preventDefault(); showRowMenu(session, e.clientX, e.clientY); }}
                  onContextAt={(x, y) => showRowMenu(session, x, y)}
                  onRename={() => setRenamingId(session.id)}
                  onArchive={() => session.archived ? void archiveSession(session.id, false) : void archiveWithConfirmation([session.id])}
                />
              )}
            </For>
          </Show>
        </Show>

        <Show when={archivedCount() > 0}>
          <button class="sidebar-archived-toggle" onClick={() => setShowArchived((v) => !v)}>
            <Icon name="archive" size={13} />
            {showArchived() ? "Hide archived" : `Show archived (${archivedCount()})`}
          </button>
        </Show>
      </div>

      <div class="sidebar-foot">
        <Show when={updateInfo()}>
          {(info) => (
            <button class="sidebar-foot-btn sidebar-update" onClick={props.onOpenUpdate} title={`Update to ${info().version}`}>
              <Icon name="download" size={15} /> Update available · {info().version}
            </button>
          )}
        </Show>
        <div class="sidebar-foot-row">
          <button class="sidebar-foot-btn" onClick={props.onOpenProjects} title="Projects">
            <Icon name="folderPlus" size={14} /> Projects
          </button>
          <button class="sidebar-foot-btn" onClick={props.onOpenSettings} title="Settings (⌘,)">
            <Icon name="settings" size={14} /> Settings
          </button>
          <button ref={themeButton} class="icon-btn" onClick={cycleTheme} title={`Theme: ${layout.theme} (click to change)`} aria-label="Change theme">
            <Icon name={themeIcon()} size={15} />
          </button>
          <button class="icon-btn" onClick={() => openPalette()} title="Search everything (⌘K)" aria-label="Search everything">
            <Icon name="search" size={15} />
          </button>
        </div>
      </div>

      <Show when={drag()}>{(moving) => <Portal><div class="project-drag-preview" style={{left:`${moving().x + 14}px`,top:`${moving().y + 12}px`}} aria-hidden="true"><Icon name="folder" size={14} />{projectName(moving().path)}</div></Portal>}</Show>
      <Show when={sessionDrag()}>{(moving) => <Portal><div class="project-drag-preview session-drag-preview" style={{left:`${moving().x + 14}px`,top:`${moving().y + 12}px`}} aria-hidden="true"><Icon name="message" size={13} />{chat.sessions.find((session) => session.id === moving().id)?.title || "Session"}</div></Portal>}</Show>

      <SessionHoverCard />
      <ContextMenu open={!!projectMenu()} onClose={() => setProjectMenu(null)} x={projectMenu()?.x ?? 0} y={projectMenu()?.y ?? 0} width={230}>
        <Show when={projectMenu()}>{(item) => <>
          <MenuLabel>{projectName(item().path)}</MenuLabel>
          <MenuItem onSelect={() => { const path=item().path; setProjectMenu(null); newConversation(path); }}><Icon name="plus" size={14} />New session</MenuItem>
          <MenuItem onSelect={() => { const path=item().path; setProjectMenu(null); void openProjectPath(path); }}><Icon name="folder" size={14} />Open project</MenuItem>
          <MenuItem onSelect={() => { const path = item().path; setProjectMenu(null); setProjectFilter(layout.projectFilter === path ? null : path); }}>
            <Icon name="list" size={14} />{layout.projectFilter === item().path ? "Show all projects" : "Filter by this project"}
          </MenuItem>
          <MenuItem onSelect={() => { const path=item().path; setProjectMenu(null); openProjectSettings(path); }}><Icon name="settings" size={14} />Project settings…</MenuItem>
          <MenuItem onSelect={() => renameProject(item().path)}><Icon name="pencil" size={14} />Rename…</MenuItem>
          <Show when={layout.projectNames[item().path]}><MenuItem onSelect={() => { setProjectDisplayName(item().path, ""); setProjectMenu(null); }}><Icon name="refresh" size={14} />Reset name</MenuItem></Show>
          <MenuItem onSelect={() => { toggleProjectPin(item().path); setProjectMenu(null); }}>
            <Icon name="sparkle" size={14} />{isProjectPinned(item().path) ? "Unpin project" : "Pin project"}
          </MenuItem>
          <MenuDivider />
          <MenuItem disabled={projectIndex(item().path) <= 0} onSelect={() => { moveProject(item().path, -1); setProjectMenu(null); }}><Icon name="arrowUp" size={14} />Move up</MenuItem>
          <MenuItem disabled={projectIndex(item().path) >= projects().length - 1} onSelect={() => { moveProject(item().path, 1); setProjectMenu(null); }}><Icon name="arrowDown" size={14} />Move down</MenuItem>
          <MenuDivider />
          <Show when={quickEditor()}>
            {(editor) => <MenuItem onSelect={() => { const path=item().path; setProjectMenu(null); void openIn(editor().id, path); }}><Icon name="code" size={14} />Open in {editor().name}</MenuItem>}
          </Show>
          <MenuItem onSelect={() => { const path=item().path; setProjectMenu(null); void revealItemInDir(path).catch((error) => toast(`Couldn't reveal project: ${String(error)}`, "error")); }}><Icon name="folder" size={14} />Reveal folder</MenuItem>
          <MenuItem onSelect={() => { const path=item().path; setProjectMenu(null); void writeClipboardText(path, "project path").catch((error) => toast(String(error), "error")); }}><Icon name="copy" size={14} />Copy path</MenuItem>
          <MenuDivider />
          <MenuItem disabled={chat.sessions.filter((session) => session.project_path === item().path && !session.archived).length === 0}
            onSelect={() => {
              const path = item().path;
              const ids = chat.sessions.filter((session) => session.project_path === path && !session.archived).map((session) => session.id);
              setProjectMenu(null);
              void archiveSessions(ids, true);
            }}><Icon name="archive" size={14} />Archive all sessions ({chat.sessions.filter((session) => session.project_path === item().path && !session.archived).length})</MenuItem>
          <Show when={chat.sessions.some((session) => session.project_path === item().path && session.archived)}>
            <MenuItem onSelect={() => {
              const path = item().path;
              const ids = chat.sessions.filter((session) => session.project_path === path && session.archived).map((session) => session.id);
              setProjectMenu(null);
              void archiveSessions(ids, false);
            }}><Icon name="refresh" size={14} />Restore archived ({chat.sessions.filter((session) => session.project_path === item().path && session.archived).length})</MenuItem>
          </Show>
          <MenuItem onSelect={() => { const path=item().path; setProjectMenu(null); void removeSidebarProject(path); }}><Icon name="trash" size={14} />Remove project…</MenuItem>
        </>}</Show>
      </ContextMenu>

      <ContextMenu open={!!menu()} onClose={() => setMenu(null)} x={menu()?.x ?? 0} y={menu()?.y ?? 0} width={210}>
        <Show when={menu()}>
          {(m) => (
            <>
              <MenuLabel>{m().session.title || "New session"}</MenuLabel>
              <MenuItem onSelect={() => { setRenamingId(m().session.id); setMenu(null); }}>
                <Icon name="pencil" size={14} /> Rename
              </MenuItem>
              <Show when={isScratchSession(m().session.project_path)}>
                <MenuItem onSelect={() => { const s = m().session; promoteScratch(s.project_path); setProjectDisplayName(s.project_path, s.title || projectName(s.project_path)); setMenu(null); toast("Now a project. Nothing moved; it keeps working in the same folder.", "info"); }}>
                  <Icon name="folderPlus" size={14} /> Turn into project
                </MenuItem>
              </Show>
              <MenuItem onSelect={() => { void regenerateTitle(m().session.id); setMenu(null); }}>
                <Icon name="sparkle" size={14} /> Regenerate title
              </MenuItem>
              <MenuItem onSelect={() => { const session = m().session; setMenu(null); void restartAgentSession(session.id); }}>
                <Icon name="refresh" size={14} /> Restart agent session
              </MenuItem>
              <MenuItem onSelect={() => { const session = m().session; setMenu(null); void forkSession(session.id); }}>
                <Icon name="layers" size={14} /> Branch conversation
              </MenuItem>
              <MenuItem onSelect={async () => {
                const session = m().session;
                setMenu(null);
                if (await confirmDialog("Clear this conversation? Its transcript is archived and a new empty one starts in the same session.", "Clear conversation")) void clearSession(session.id);
              }}>
                <Icon name="remove" size={14} /> Clear conversation…
              </MenuItem>
              <MenuItem onSelect={() => { const session = m().session; setMenu(null); void exportConversation(session.id); }}>
                <Icon name="download" size={14} /> Export as Markdown…
              </MenuItem>
              <MenuItem onSelect={() => { void pinWithConfirmation(m().session.id, !m().session.pinned); setMenu(null); }}>
                <Icon name="sparkle" size={14} /> {m().session.pinned ? "Unpin" : "Pin to top"}
              </MenuItem>
              <MenuItem onSelect={() => { void setSettleDisabled(m().session.id, !m().session.settle_disabled); setMenu(null); }}>
                <Icon name="history" size={14} /> {m().session.settle_disabled ? "Include in auto-archive" : "Exclude from auto-archive"}
              </MenuItem>
              <MenuItem onSelect={() => { const session = m().session; setMenu(null); if (session.archived) void archiveSession(session.id, false); else void archiveWithConfirmation([session.id]); }}>
                <Icon name="archive" size={14} /> {m().session.archived ? "Unarchive" : "Archive"}
              </MenuItem>
              <MenuDivider />
              <MenuLabel>Snooze</MenuLabel>
              <Show when={m().session.snoozed_until && m().session.snoozed_until! > Date.now()}>
                <MenuItem onSelect={() => { void snoozeSession(m().session.id, null); setMenu(null); }}>
                  <Icon name="history" size={14} /> Wake now
                </MenuItem>
              </Show>
              <For each={snoozePresets(new Date())}>
                {(preset) => (
                  <MenuItem onSelect={() => { void snoozeSession(m().session.id, preset.until); setMenu(null); }}>
                    <Icon name="history" size={14} /> {preset.label}
                  </MenuItem>
                )}
              </For>
              <MenuItem onSelect={() => { const s = m().session; setMenu(null); requestCustomSnooze([s.id], s.title); }}>
                <Icon name="history" size={14} /> Custom…
              </MenuItem>
              <MenuDivider />
              <MenuItem onSelect={() => { setSelectedIds(new Set([m().session.id])); setSelectionAnchor(m().session.id); setMenu(null); }}>
                <Icon name="check" size={14} /> Select
              </MenuItem>
              <Show when={m().session.worktree}>
                <MenuItem onSelect={() => { const session = m().session; setMenu(null); void startSessionInWorktree(session.id); }}>
                  <Icon name="plus" size={14} /> New session in this worktree
                </MenuItem>
              </Show>
              <MenuItem disabled={!canMoveSession(m().session.id, -1)} onSelect={() => { moveSession(m().session.id, -1); setMenu(null); }}>
                <Icon name="arrowUp" size={14} /> Move up
              </MenuItem>
              <MenuItem disabled={!canMoveSession(m().session.id, 1)} onSelect={() => { moveSession(m().session.id, 1); setMenu(null); }}>
                <Icon name="arrowDown" size={14} /> Move down
              </MenuItem>
              <MenuItem onSelect={() => {
                const session = m().session;
                const isUnread = chat.attention[session.id] || isManuallyUnread(session.id);
                if (isUnread) { markRead(session.id); setChat("attention", session.id, false); }
                else markUnread(session.id);
                setMenu(null);
              }}>
                <Icon name={chat.attention[m().session.id] || isManuallyUnread(m().session.id) ? "eye" : "message"} size={14} /> {chat.attention[m().session.id] || isManuallyUnread(m().session.id) ? "Mark read" : "Mark unread"}
              </MenuItem>
              <MenuItem onSelect={() => { toggleSessionMuted(m().session.id); setMenu(null); }}>
                <Icon name="notificationsOff" size={14} /> {isMuted(m().session.id) ? "Unmute notifications" : "Mute notifications"}
              </MenuItem>
              <MenuDivider />
              <MenuLabel>Copy</MenuLabel>
              <MenuItem onSelect={() => { void writeClipboardText(m().session.id, "session ID").catch((error) => toast(String(error), "error")); setMenu(null); }}>
                <Icon name="copy" size={14} /> Copy session ID
              </MenuItem>
              <MenuItem onSelect={() => { void writeClipboardText(m().session.title || "New session", "session title").catch((error) => toast(String(error), "error")); setMenu(null); }}>
                <Icon name="copy" size={14} /> Copy title
              </MenuItem>
              <MenuItem onSelect={() => {
                const session = m().session;
                setMenu(null);
                void chatTranscriptPath(session.id).then((path) => writeClipboardText(path, "transcript path")).catch((error) => toast(`Couldn't find the transcript: ${String(error)}`, "error"));
              }}>
                <Icon name="copy" size={14} /> Copy transcript path
              </MenuItem>
              <MenuItem onSelect={() => { void copyThreadLink(m().session); setMenu(null); }}>
                <Icon name="link" size={14} /> Copy thread link
              </MenuItem>
              <MenuItem onSelect={() => { void writeClipboardText(m().session.cwd, "session path").catch((error) => toast(String(error), "error")); setMenu(null); }}>
                <Icon name="copy" size={14} /> Copy path
              </MenuItem>
              <Show when={m().session.worktree}>
                {(tree) => (
                  <>
                    <MenuItem onSelect={() => { void writeClipboardText(tree().branch, "worktree branch").catch((error) => toast(String(error), "error")); setMenu(null); }}>
                      <Icon name="gitBranch" size={14} /> Copy worktree branch
                    </MenuItem>
                    <MenuItem onSelect={() => { void writeClipboardText(tree().path, "worktree path").catch((error) => toast(String(error), "error")); setMenu(null); }}>
                      <Icon name="folder" size={14} /> Copy worktree path
                    </MenuItem>
                  </>
                )}
              </Show>
              <Show when={prStatusFor(m().session.cwd)}>
                {(status) => (
                  <MenuItem onSelect={() => { void writeClipboardText(status().url, "pull request link").catch((error) => toast(String(error), "error")); setMenu(null); }}>
                    <Icon name="merge" size={14} /> Copy pull request link
                  </MenuItem>
                )}
              </Show>
              <MenuDivider />
              <Show when={quickEditor()}>
                {(editor) => (
                  <MenuItem onSelect={() => { void openIn(editor().id, m().session.cwd); setMenu(null); }}>
                    <Icon name="code" size={14} /> Open in {editor().name}
                  </MenuItem>
                )}
              </Show>
              <MenuItem onSelect={() => { void revealItemInDir(m().session.cwd).catch(() => {}); setMenu(null); }}>
                <Icon name="folder" size={14} /> Reveal in Finder
              </MenuItem>
              <MenuDivider />
              <MenuItem onSelect={() => { const s = m().session; setMenu(null); void confirmDelete(s); }}>
                <Icon name="trash" size={14} /> Delete…
              </MenuItem>
            </>
          )}
        </Show>
      </ContextMenu>

      <ContextMenu open={!!bulkMenu()} onClose={() => setBulkMenu(null)} x={bulkMenu()?.x ?? 0} y={bulkMenu()?.y ?? 0} width={230}>
        <MenuLabel>{selectedCount()} sessions selected</MenuLabel>
        <MenuItem onSelect={() => { setBulkMenu(null); bulkPin(!allSelectedPinned()); }}>
          <Icon name="sparkle" size={14} /> {allSelectedPinned() ? "Unpin" : "Pin"} {selectedCount()}
        </MenuItem>
        <MenuItem onSelect={() => { setBulkMenu(null); bulkSnooze(); }}>
          <Icon name="history" size={14} /> Snooze {selectedCount()}…
        </MenuItem>
        <MenuItem onSelect={() => { setBulkMenu(null); markManyUnread([...selectedIds()]); clearSelection(); }}>
          <Icon name="message" size={14} /> Mark unread ({selectedCount()})
        </MenuItem>
        <MenuItem onSelect={() => { setBulkMenu(null); const ids = [...selectedIds()]; for (const id of ids) { markRead(id); setChat("attention", id, false); } clearSelection(); }}>
          <Icon name="eye" size={14} /> Mark read ({selectedCount()})
        </MenuItem>
        <MenuItem onSelect={() => { void bulkRegenerateTitles(); }}>
          <Icon name="sparkle" size={14} /> Regenerate titles ({selectedCount()})
        </MenuItem>
        <MenuItem onSelect={() => { setBulkMenu(null); const ids = [...selectedIds()]; for (const id of ids) setSessionMuted(id, true); clearSelection(); }}>
          <Icon name="notificationsOff" size={14} /> Mute notifications ({selectedCount()})
        </MenuItem>
        <MenuItem onSelect={() => { setBulkMenu(null); const ids = [...selectedIds()]; for (const id of ids) setSessionMuted(id, false); clearSelection(); }}>
          <Icon name="message" size={14} /> Unmute notifications ({selectedCount()})
        </MenuItem>
        <MenuItem onSelect={() => { setBulkMenu(null); bulkArchive(); }}>
          <Icon name="archive" size={14} /> Archive {selectedCount()}
        </MenuItem>
        <MenuDivider />
        <MenuItem onSelect={() => { setBulkMenu(null); clearSelection(); }}>
          <Icon name="x" size={14} /> Clear selection
        </MenuItem>
      </ContextMenu>
    </aside>
  );
};

export default Sidebar;
