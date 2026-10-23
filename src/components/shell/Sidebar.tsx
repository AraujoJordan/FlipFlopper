import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  archiveSession, chat, deleteSession, isRunning, pendingInputCount, navBack, navForward, navState, nestSessions, pinSession,
  projectName, renameSession, selectSession, sessionGroups, sessionProjects, startNewSession,
} from "../../lib/chat";
import { removeWorktree, type SessionMeta } from "../../lib/ipc";
import { cycleTheme, layout, setProjectFilter, setSidebarGroup, toggleSidebar } from "../../lib/layout";
import { store } from "../../lib/store";
import { updateInfo } from "../../lib/updater";
import { openPalette } from "../../lib/palette";
import { AgentLogo } from "../../lib/agentMeta";
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

const agentIcon = (id: string) => store.agents.find((a) => a.id === id)?.icon ?? null;

const SessionRow: Component<{
  session: SessionMeta;
  depth: number;
  /** Shown when sessions of several projects share a group (date grouping, pinned). */
  projectLabel?: string;
  renaming: boolean;
  onRenameDone: () => void;
  onContext: (e: MouseEvent) => void;
  onRename: () => void;
  onArchive: () => void;
}> = (props) => {
  const active = () => chat.activeId === props.session.id;
  const running = () => isRunning(props.session.id);
  const attention = () => chat.attention[props.session.id];
  const waiting = () => pendingInputCount(props.session.id) > 0;
  const [draft, setDraft] = createSignal(props.session.title);

  let row: HTMLDivElement | undefined;
  useValueMotion(() => row?.querySelector<HTMLElement>(".session-row-text, .session-row-input") ?? undefined, () => `${props.renaming}:${props.session.title}`);
  const commit = () => {
    void renameSession(props.session.id, draft());
    props.onRenameDone();
  };

  return (
    <div
      ref={row} class="session-row" data-motion-key={props.session.id}
      classList={{ "session-row-active": active(), "session-row-archived": props.session.archived, "session-row-child": props.depth > 0 }}
      role="button"
      tabIndex={0}
      onClick={() => !props.renaming && void selectSession(props.session.id)}
      onKeyDown={(e) => {
        if (props.renaming) return;
        const rows = () => [...document.querySelectorAll<HTMLElement>(".session-row")];
        const move = (dir: 1 | -1) => {
          const list = rows();
          const next = list[list.indexOf(e.currentTarget as HTMLElement) + dir];
          if (next) { e.preventDefault(); next.focus(); }
        };
        if (e.key === "Enter") void selectSession(props.session.id);
        else if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "F2") { e.preventDefault(); props.onRename(); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); props.onArchive(); }
      }}
      onContextMenu={props.onContext}
      title={waiting() ? `${props.session.title} · Needs input` : props.session.title}
    >
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
      <Show when={attention() && !active()}><span class="session-dot session-dot-attention" title="Finished" /></Show>
      <Show when={props.session.status === "error" && !running() && !attention()}>
        <span class="session-dot session-dot-error" title="Last turn failed" />
      </Show>
      <span class="session-row-time">{ago(props.session.updated_at)}</span>
    </div>
  );
};

const Sidebar: Component<{ onOpenSettings: () => void; onOpenProjects: () => void; onOpenUpdate: () => void }> = (props) => {
  const [query, setQuery] = createSignal("");
  const [showArchived, setShowArchived] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<{ x: number; y: number; session: SessionMeta } | null>(null);

  const groups = createMemo(() =>
    sessionGroups({ includeArchived: showArchived(), query: query(), group: layout.sidebarGroup, filter: layout.projectFilter }),
  );
  const projects = createMemo(sessionProjects);
  const [filterOpen, setFilterOpen] = createSignal(false);
  let filterAnchor: HTMLButtonElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  const filterLabel = () => projects().find((p) => p.path === layout.projectFilter)?.name ?? "All projects";
  const themeIcon = () => (layout.theme === "dark" ? "sparkle" : layout.theme === "light" ? "eye" : "settings") as "sparkle" | "eye" | "settings";
  const archivedCount = () => chat.sessions.filter((s) => s.archived).length;
  let sidebar: HTMLElement | undefined;
  let themeButton: HTMLButtonElement | undefined;
  useListMotion(() => sidebar, () => groups().map((g) => g.sessions.map((s) => s.id).join()).join("|"), ".session-row");
  useSelectionMotion(() => sidebar, () => chat.activeId, ".session-row-active");
  useValueMotion(() => themeButton, () => layout.theme, true);

  async function confirmDelete(session: SessionMeta) {
    if (!(await confirmDialog(`Delete “${session.title || "this session"}”? The conversation can't be recovered.`, "Delete"))) return;
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
    <aside ref={sidebar} class="sidebar">
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
      </div>

      <button class="new-session-btn" onClick={() => startNewSession()}>
        <Icon name="plus" size={15} />
        New session
        <kbd>⌘N</kbd>
      </button>

      <div class="sidebar-search">
        <Icon name="search" size={14} />
        <input
          ref={searchInput}
          placeholder="Search sessions"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          spellcheck={false}
        />
        <Show when={query()}>
          <button class="icon-btn" onClick={() => setQuery("")} aria-label="Clear search"><Icon name="x" size={12} /></button>
        </Show>
      </div>

      <div class="sidebar-filters">
        <button ref={filterAnchor} class="filter-pill" onClick={() => setFilterOpen((v) => !v)} title="Filter by project">
          <Icon name="folder" size={13} /> <span>{filterLabel()}</span> <Icon name="chevronDown" size={11} />
        </button>
        <div class="seg seg-small" role="group" aria-label="Group sessions by">
          <button class="seg-btn" classList={{ "seg-on": layout.sidebarGroup === "project" }} onClick={() => setSidebarGroup("project")}>Project</button>
          <button class="seg-btn" classList={{ "seg-on": layout.sidebarGroup === "date" }} onClick={() => setSidebarGroup("date")}>Date</button>
        </div>
        <Menu open={filterOpen()} onClose={() => setFilterOpen(false)} anchorRef={filterAnchor} width={240}>
          <MenuLabel>Show sessions from</MenuLabel>
          <MenuItem onSelect={() => { setProjectFilter(null); setFilterOpen(false); }}>
            <span style={{ flex: 1 }}>All projects</span>
            <Show when={!layout.projectFilter}><Icon name="check" size={14} /></Show>
          </MenuItem>
          <For each={projects()}>
            {(p) => (
              <MenuItem onSelect={() => { setProjectFilter(p.path); setFilterOpen(false); }}>
                <Icon name="folder" size={14} />
                <span style={{ flex: 1 }}>{p.name}</span>
                <Show when={layout.projectFilter === p.path}><Icon name="check" size={14} /></Show>
              </MenuItem>
            )}
          </For>
        </Menu>
      </div>

      <div class="sidebar-scroll">
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
              <section class="session-group">
                <div class="session-group-head">
                  <button
                    class="session-group-toggle"
                    onClick={() => setCollapsed((c) => ({ ...c, [group.key]: !c[group.key] }))}
                    title={group.projectPath ?? group.label}
                  >
                    <Icon
                      name="chevronRight"
                      size={12}
                      style={{ transform: collapsed()[group.key] ? "none" : "rotate(90deg)", transition: "transform var(--dur-fast)" }}
                    />
                    <Icon name={group.key === "pinned" ? "sparkle" : group.projectPath ? "folder" : "history"} size={14} />
                    <span class="session-group-name">{group.label}</span>
                  </button>
                  <Show when={group.projectPath}>
                    <button
                      class="icon-btn session-group-add"
                      onClick={() => startNewSession(group.projectPath)}
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
                        projectLabel={group.projectPath ? undefined : projectName(session.project_path)}
                        renaming={renamingId() === session.id}
                        onRenameDone={() => setRenamingId(null)}
                        onContext={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, session }); }}
                        onRename={() => setRenamingId(session.id)}
                        onArchive={() => void archiveSession(session.id, !session.archived)}
                      />
                    )}
                  </For>
                </Disclosure>
              </section>
            )}
          </For>
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
        <button class="sidebar-foot-btn" onClick={props.onOpenProjects}>
          <Icon name="folderPlus" size={15} /> Projects
        </button>
        <div class="sidebar-foot-row">
          <button class="sidebar-foot-btn" onClick={props.onOpenSettings}>
            <Icon name="settings" size={15} /> Settings
          </button>
          <button class="icon-btn" onClick={cycleTheme} title={`Theme: ${layout.theme} (click to change)`} aria-label="Change theme">
            <Icon name={themeIcon()} size={15} />
          </button>
          <button class="icon-btn" onClick={openPalette} title="Search everything (⌘K)" aria-label="Search everything">
            <Icon name="search" size={15} />
          </button>
        </div>
      </div>

      <ContextMenu open={!!menu()} onClose={() => setMenu(null)} x={menu()?.x ?? 0} y={menu()?.y ?? 0} width={210}>
        <Show when={menu()}>
          {(m) => (
            <>
              <MenuItem onSelect={() => { setRenamingId(m().session.id); setMenu(null); }}>
                <Icon name="pencil" size={14} /> Rename
              </MenuItem>
              <MenuItem onSelect={() => { void pinSession(m().session.id, !m().session.pinned); setMenu(null); }}>
                <Icon name="sparkle" size={14} /> {m().session.pinned ? "Unpin" : "Pin to top"}
              </MenuItem>
              <MenuItem onSelect={() => { void archiveSession(m().session.id, !m().session.archived); setMenu(null); }}>
                <Icon name="archive" size={14} /> {m().session.archived ? "Unarchive" : "Archive"}
              </MenuItem>
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
    </aside>
  );
};

export default Sidebar;
