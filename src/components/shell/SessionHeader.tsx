import { useValueMotion, useSelectionMotion } from "../ui";
import { Component, Show, createSignal } from "solid-js";
import { activeSession, activeView, projectName, renameSession } from "../../lib/chat";
import { layout, openSide, toggleSidebar, toggleSide, type SideTab } from "../../lib/layout";
import { store } from "../../lib/store";
import BranchIndicator from "../BranchIndicator";
import { Icon, type IconName } from "./Icon";

const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
const SHIFT = navigator.platform.toLowerCase().includes("mac") ? "⇧" : "Shift+";

const PANE_BUTTONS: { tab: SideTab; icon: IconName; label: string; keys?: string }[] = [
  { tab: "changes", icon: "diff", label: "Changes", keys: `${MOD}${SHIFT}G` },
  { tab: "preview", icon: "globe", label: "Preview" },
  { tab: "terminal", icon: "terminal", label: "Terminal", keys: `${MOD}J` },
  { tab: "flow", icon: "flow", label: "Flow" },
  { tab: "explain", icon: "help", label: "Explain" },
];

/** App toolbar below the native title bar: editable session title, project +
 *  branch, and the side-pane toggles. Window actions belong to the OS. */
const SessionHeader: Component<{ changeCount: number }> = (props) => {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let badge: HTMLSpanElement | undefined;
  let toggles: HTMLDivElement | undefined;
  useValueMotion(() => badge, () => props.changeCount);
  useSelectionMotion(() => toggles, () => layout.sideOpen ? layout.sideTab : "", ".pane-toggle-on", true);
  const session = () => activeSession();
  const project = () => store.currentProject?.path ?? session()?.project_path ?? null;

  const title = () => session()?.title || (session() ? "New session" : "New session");
  const finish = (save: boolean) => {
    const s = session();
    if (save && s) void renameSession(s.id, draft());
    setEditing(false);
  };

  return (
    <header class="session-header">
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
              title={session() ? "Rename session" : undefined}
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
        <Show when={project()}>
          <span class="session-header-project" title={project()!}>
            <Icon name="folder" size={13} />
            {projectName(project()!)}
          </span>
        </Show>
        <Show when={activeView()?.running}>
          <span class="session-header-live">Working…</span>
        </Show>
      </div>

      <div class="session-header-actions">
        <Show when={project()}>
          <BranchIndicator />
        </Show>
        <div ref={toggles} class="pane-toggles">
          {PANE_BUTTONS.map((b) => (
            <button
              class="pane-toggle"
              classList={{ "pane-toggle-on": layout.sideOpen && layout.sideTab === b.tab }}
              onClick={() => (layout.sideOpen && layout.sideTab === b.tab ? toggleSide() : openSide(b.tab))}
              title={b.keys ? `${b.label} (${b.keys})` : b.label}
              aria-label={b.label}
              aria-pressed={layout.sideOpen && layout.sideTab === b.tab}
            >
              <Icon name={b.icon} size={15} />
              <Show when={b.tab === "changes" && props.changeCount > 0}>
                <span ref={badge} class="pane-toggle-badge">{props.changeCount}</span>
              </Show>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
};

export default SessionHeader;
