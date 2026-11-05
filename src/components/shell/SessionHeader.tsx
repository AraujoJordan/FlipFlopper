import { Menu, MenuDivider, MenuItem, MenuLabel, useValueMotion, useSelectionMotion } from "../ui";
import { Component, Show, createSignal } from "solid-js";
import { activeSession, activeView, chat, renameSession, conversationMode, setConversationMode } from "../../lib/chat";
import { layout, openSide, toggleFocusView, toggleSidebar, toggleSide, toggleTerminalDrawer, type SideTab } from "../../lib/layout";
import BranchIndicator from "../BranchIndicator";
import ThreadDetailsCard from "./ThreadDetailsCard";
import { Icon, type IconName } from "./Icon";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setCompareGroup } from "../CompareDialog";
import { prChip, prStatusFor } from "../../lib/prStatus";
import { openIn, openInApps, preferredEditorId } from "../../lib/openIn";
import { effectiveRoot, store } from "../../lib/store";
import { formatUsage, sessionUsage } from "../../lib/usage";
import { clearGoal, pauseGoal, resumeGoal, sessionGoal } from "../../lib/goals";
import { archiveSession, pinSession, regenerateTitle, restartAgentSession, startSessionInWorktree } from "../../lib/chat";
import { openWorktreeDialog } from "../git/WorktreeCloseDialog";
import { openProjectSettings } from "../ProjectSettingsDialog";
import { isManuallyUnread, markRead, markUnread } from "../../lib/unread";
import { isMuted, setSessionMuted } from "../../lib/muted";
import { writeClipboardText } from "../../lib/native";
import { chatTranscriptPath } from "../../lib/ipc";
import { copyThreadLink } from "../../lib/promptLinks";
import { AgentLogo } from "../../lib/agentMeta";

const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
const SHIFT = navigator.platform.toLowerCase().includes("mac") ? "⇧" : "Shift+";

const PANE_BUTTONS: { tab: SideTab; icon: IconName; label: string; keys?: string }[] = [
  { tab: "changes", icon: "diff", label: "Changes", keys: `${MOD}${SHIFT}G` },
  { tab: "preview", icon: "globe", label: "Preview" },
  { tab: "flow", icon: "flow", label: "Flow" },
  { tab: "explain", icon: "help", label: "Explain" },
  { tab: "files", icon: "folder", label: "Files" },
  { tab: "pulls", icon: "merge", label: "Pull requests" },
  { tab: "sidechat", icon: "message", label: "Side chats" },
];

/** Conversation toolbar, integrated into the title bar on macOS: editable session title,
 *  branch, and the side-pane toggles. Window actions belong to the OS. */
const SessionHeader: Component<{ changeCount: number }> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [moreOpen, setMoreOpen] = createSignal(false);
  const [goalOpen, setGoalOpen] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  let goalAnchor: HTMLButtonElement | undefined;
  let moreAnchor: HTMLButtonElement | undefined;
  let detailsAnchor: HTMLButtonElement | undefined;
  let badge: HTMLSpanElement | undefined;
  let toggles: HTMLDivElement | undefined;
  useValueMotion(() => badge, () => props.changeCount);
  useSelectionMotion(() => toggles, () => layout.sideOpen ? layout.sideTab : "", ".pane-toggle-on", true);
  const session = () => activeSession();
  const project = () => store.currentProject?.path ?? session()?.project_path ?? null;

  const title = () => session()?.title || "New session";
  const usageLabel = () => formatUsage(sessionUsage(activeView()));
  const cliAgentId = () => session()?.agent_id ?? chat.composer.agentId;
  const cliAgentIcon = () => store.agents.find((agent) => agent.id === cliAgentId())?.icon ?? null;
  const cliAgent = () => {
    const id = cliAgentId();
    const name = store.agents.find((agent) => agent.id === id)?.name ?? id;
    return name.endsWith("CLI") ? name : `${name} CLI`;
  };
  const finish = (save: boolean) => {
    const s = session();
    if (save && s) void renameSession(s.id, draft());
    setEditing(false);
  };

  return (
    <header class="session-header" data-window-header>
      <Show when={!layout.sidebarOpen}>
        <button class="icon-btn" onClick={toggleSidebar} title="Show sidebar (⌘B)" aria-label="Show sidebar">
          <Icon name="sidebar" size={16} />
        </button>
      </Show>

      <div class="session-header-title">
        <Show
          when={editing()}
          fallback={
            <button
              class="session-title-btn"
              disabled={!session()}
              onClick={() => { setDraft(session()?.title ?? ""); setEditing(true); }}
              title={session() ? `Rename session${usageLabel() ? ` · ${usageLabel()}` : ""}` : undefined}
            >
              {title()}
            </button>
          }
        >
          <input
            class="session-title-input"
            value={draft()}
            ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 10)}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); }}
            onBlur={() => finish(true)}
          />
        </Show>
        <Show when={activeView()?.running}>
          <span class="session-header-live">Working…</span>
        </Show>
        <Show when={session()?.compare_group}>
          <button class="session-header-live" style={{ cursor: "pointer", border: "none", background: "none" }} onClick={() => setCompareGroup(session()!.compare_group!)} title="Compare the agents started together">Compare</button>
        </Show>
        <Show when={layout.focusView}>
          <button class="session-header-live" style={{ cursor: "pointer", border: "none", background: "none" }} onClick={toggleFocusView} title="Showing final answers only. Click to show all work.">Final answers</button>
        </Show>
        <Show when={sessionGoal(session()?.id)}>
          {(goal) => (
            <>
              <button ref={goalAnchor} class="session-header-live" style={{ cursor: "pointer", border: "none", background: "none" }} aria-haspopup="menu" aria-expanded={goalOpen()}
                title={goal().text} onClick={() => setGoalOpen((v) => !v)}>
                Goal · {goal().status === "active" ? `turn ${goal().rounds + 1}/${goal().max_rounds}` : goal().status}
              </button>
              <Menu open={goalOpen()} onClose={() => setGoalOpen(false)} anchorRef={goalAnchor} align="left" width={260}>
                <MenuLabel>{goal().text.length > 60 ? `${goal().text.slice(0, 60)}…` : goal().text}</MenuLabel>
                <Show when={goal().note}><MenuLabel>{goal().note}</MenuLabel></Show>
                <Show when={goal().status === "active"} fallback={<MenuItem onSelect={() => { setGoalOpen(false); resumeGoal(session()!.id); }}><span>Resume (resets turns)</span></MenuItem>}>
                  <MenuItem onSelect={() => { setGoalOpen(false); pauseGoal(session()!.id); }}><span>Pause</span></MenuItem>
                </Show>
                <MenuItem onSelect={() => { setGoalOpen(false); clearGoal(session()!.id); }}><span>Clear goal</span></MenuItem>
              </Menu>
            </>
          )}
        </Show>
      </div>

      <div class="session-header-actions">
        <button
          ref={detailsAnchor}
          class="pane-toggle"
          classList={{ "pane-toggle-on": detailsOpen() }}
          title="Thread details"
          aria-label="Thread details"
          aria-haspopup="menu"
          aria-expanded={detailsOpen()}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <Icon name="info" size={15} />
        </button>
        <div class="conversation-mode" role="group" aria-label="Conversation view">
          <button class="pane-toggle" classList={{ "pane-toggle-on": conversationMode() === "chat" }} aria-pressed={conversationMode() === "chat"} onClick={() => void setConversationMode("chat")}>Chat</button>
          <button class="pane-toggle pane-toggle-cli" classList={{ "pane-toggle-on": conversationMode() === "cli" }} aria-pressed={conversationMode() === "cli"} aria-label={cliAgent()} onClick={() => void setConversationMode("cli")} title={`Use ${cliAgent()}'s terminal interface`}>
            <AgentLogo agentId={cliAgentId()} icon={cliAgentIcon()} size={13} radius={3} />
            <span>CLI</span>
          </button>
        </div>
        <Show when={project()}>
          <div class="session-header-branch"><BranchIndicator /></div>
          <Show when={prStatusFor(effectiveRoot())}>
            {(pr) => {
              const chip = () => prChip(pr());
              return (
                <button type="button" class="pr-chip" data-tone={chip().tone} title={chip().title} aria-label={`${chip().label}. Open on GitHub`}
                  onClick={() => void openUrl(pr().url).catch(() => {})}>
                  <span class="pr-chip-dot" aria-hidden="true" />{chip().label}
                </button>
              );
            }}
          </Show>
        </Show>
        <div ref={toggles} class="pane-toggles">
          {PANE_BUTTONS.slice(0, 2).map((b) => (
            <button
              class={`pane-toggle${b.tab === "changes" ? " pane-toggle-labeled" : ""}`}
              classList={{ "pane-toggle-on": layout.sideOpen && layout.sideTab === b.tab }}
              onClick={() => (layout.sideOpen && layout.sideTab === b.tab ? toggleSide() : openSide(b.tab))}
              title={b.keys ? `${b.label} (${b.keys})` : b.label}
              aria-label={b.label}
              aria-pressed={layout.sideOpen && layout.sideTab === b.tab}
            >
              <Icon name={b.icon} size={15} />
              <Show when={b.tab === "changes"}><span>Changes</span></Show>
              <Show when={b.tab === "changes" && props.changeCount > 0}>
                <span ref={badge} class="pane-toggle-badge">{props.changeCount}</span>
              </Show>
            </button>
          ))}
          <button class="pane-toggle" classList={{ "pane-toggle-on": layout.terminalDrawer }}
            onClick={toggleTerminalDrawer} title={`Terminal (${MOD}J)`} aria-label="Terminal" aria-pressed={layout.terminalDrawer}>
            <Icon name="terminal" size={15} />
          </button>
          <button ref={moreAnchor} class="pane-toggle" aria-label="More tools" title="More tools" aria-haspopup="menu" aria-expanded={moreOpen()}
            classList={{ "pane-toggle-on": layout.sideOpen && (layout.sideTab === "flow" || layout.sideTab === "explain" || layout.sideTab === "files" || layout.sideTab === "pulls" || layout.sideTab === "sidechat") }}
            onClick={() => setMoreOpen((v) => !v)}><Icon name="more" size={18} /></button>
          <Menu open={moreOpen()} onClose={() => setMoreOpen(false)} anchorRef={moreAnchor} align="right" width={220}>
            <MenuLabel>Tools</MenuLabel>
            {PANE_BUTTONS.slice(2).map((b) => (
              <MenuItem onSelect={() => { setMoreOpen(false); layout.sideOpen && layout.sideTab === b.tab ? toggleSide() : openSide(b.tab); }}>
                <Icon name={b.icon} size={16} /><span style={{ flex: 1 }}>{b.label}</span>
                <Show when={layout.sideOpen && layout.sideTab === b.tab}><Icon name="check" size={14} /></Show>
              </MenuItem>
            ))}
            <MenuDivider />
            <MenuItem onSelect={() => { setMoreOpen(false); toggleFocusView(); }}>
              <Icon name="list" size={16} /><span style={{ flex: 1 }}>Final answers only</span>
              <Show when={layout.focusView}><Icon name="check" size={14} /></Show>
            </MenuItem>
            <MenuLabel>Session</MenuLabel>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void restartAgentSession(current().id); }}>
                  <Icon name="refresh" size={16} /><span style={{ flex: 1 }}>Restart agent session</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void regenerateTitle(current().id); }}>
                  <Icon name="sparkle" size={16} /><span style={{ flex: 1 }}>Regenerate title</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void archiveSession(current().id, true); }}>
                  <Icon name="archive" size={16} /><span style={{ flex: 1 }}>Archive session</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void pinSession(current().id, !current().pinned); }}>
                  <Icon name="sparkle" size={16} /><span style={{ flex: 1 }}>{current().pinned ? "Unpin session" : "Pin session"}</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => {
                  const id = current().id;
                  setMoreOpen(false);
                  if (chat.attention[id] || isManuallyUnread(id)) markRead(id); else markUnread(id);
                }}>
                  <Icon name="message" size={16} /><span style={{ flex: 1 }}>{chat.attention[session()?.id ?? ""] || isManuallyUnread(session()?.id ?? "") ? "Mark read" : "Mark unread"}</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => { setMoreOpen(false); setSessionMuted(current().id, !isMuted(current().id)); }}>
                  <Icon name="notificationsOff" size={16} /><span style={{ flex: 1 }}>{isMuted(current().id) ? "Unmute notifications" : "Mute notifications"}</span>
                </MenuItem>
              )}
            </Show>
            <MenuDivider />
            <MenuLabel>Workspace</MenuLabel>
            <Show when={project()}>
              {(path) => (
                <MenuItem onSelect={() => { setMoreOpen(false); openProjectSettings(path()); }}>
                  <Icon name="settings" size={16} /><span style={{ flex: 1 }}>Project settings…</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()?.worktree}>
              <MenuItem onSelect={() => { const id = session()?.id; setMoreOpen(false); if (id) void startSessionInWorktree(id); }}>
                <Icon name="plus" size={16} /><span style={{ flex: 1 }}>New session in this worktree</span>
              </MenuItem>
            </Show>
            <Show when={session()?.worktree}>
              <MenuItem onSelect={() => { const id = session()?.id; setMoreOpen(false); if (id) void openWorktreeDialog(id); }}>
                <Icon name="merge" size={16} /><span style={{ flex: 1 }}>Merge back or discard…</span>
              </MenuItem>
            </Show>
            <MenuDivider />
            <MenuLabel>Copy</MenuLabel>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void writeClipboardText(current().id, "session ID").catch(() => {}); }}>
                  <Icon name="copy" size={16} /><span style={{ flex: 1 }}>Copy session ID</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void writeClipboardText(current().title || "New session", "session title").catch(() => {}); }}>
                  <Icon name="copy" size={16} /><span style={{ flex: 1 }}>Copy session title</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()}>
              {(current) => (
                <MenuItem onSelect={() => {
                  const id = current().id;
                  setMoreOpen(false);
                  void chatTranscriptPath(id).then((path) => writeClipboardText(path, "transcript path")).catch(() => {});
                }}>
                  <Icon name="copy" size={16} /><span style={{ flex: 1 }}>Copy transcript path</span>
                </MenuItem>
              )}
            </Show>
            <Show when={effectiveRoot()}>
              {(root) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void writeClipboardText(root(), "working directory").catch(() => {}); }}>
                  <Icon name="folder" size={16} /><span style={{ flex: 1 }}>Copy working directory</span>
                </MenuItem>
              )}
            </Show>
            <Show when={store.currentBranch}>
              {(branch) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void writeClipboardText(branch(), "branch name").catch(() => {}); }}>
                  <Icon name="copy" size={16} /><span style={{ flex: 1 }}>Copy branch name</span>
                </MenuItem>
              )}
            </Show>
            <Show when={prStatusFor(effectiveRoot())}>
              {(status) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void writeClipboardText(status().url, "pull request link").catch(() => {}); }}>
                  <Icon name="merge" size={16} /><span style={{ flex: 1 }}>Copy pull request link</span>
                </MenuItem>
              )}
            </Show>
            <Show when={session()}>
              <MenuDivider />
              <MenuItem onSelect={() => { setMoreOpen(false); void copyThreadLink(session()!); }}>
                <Icon name="link" size={16} /><span style={{ flex: 1 }}>Copy thread link</span>
              </MenuItem>
            </Show>
            <Show when={effectiveRoot() && openInApps().length > 0}>
              <MenuDivider />
              <MenuLabel>Open in</MenuLabel>
              {openInApps().map((app) => (
                <MenuItem onSelect={() => { setMoreOpen(false); void openIn(app.id, effectiveRoot()!); }}>
                  <Icon name={app.kind === "terminal" ? "terminal" : app.kind === "files" ? "folder" : "code"} size={16} />
                  <span style={{ flex: 1 }}>{app.name}</span>
                  <Show when={preferredEditorId() === app.id}><Icon name="check" size={14} /></Show>
                </MenuItem>
              ))}
            </Show>
          </Menu>
        </div>
      </div>
      <ThreadDetailsCard open={detailsOpen()} onClose={() => setDetailsOpen(false)} anchorRef={detailsAnchor} changeCount={props.changeCount} />
    </header>
  );
};

export default SessionHeader;
