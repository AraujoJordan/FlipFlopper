import { Component, For, Show, onMount, createEffect } from "solid-js";
import { chat, projectName } from "../../lib/chat";
import { openProjectPath } from "../../lib/projects";
import { store } from "../../lib/store";
import { installAgent, installable, installing, loadInstallable } from "../../lib/install";
import { dismissBanner, pendingCandidates, setImportOpen } from "../../lib/importer";
import { Spinner, reveal } from "../ui";
import { Icon } from "../shell/Icon";

let introduced = false;

/** New-session screen. The composer is docked below (like every other screen);
 *  this fills the space above it with the target project and shortcuts. */
const EmptyState: Component<{ onOpenProjects: () => void; onNewProject: () => void }> = (props) => {
  const project = () => chat.draftProject ?? store.currentProject?.path ?? null;
  const recents = () => store.recentProjects.filter((p) => p.path !== project()).slice(0, 5);
  const noAgents = () => store.agents.length > 0 && !store.agents.some((a) => a.installed && a.chat_supported);
  const suggestions = () => store.agents.filter((a) => a.chat_supported && !a.installed && installable().has(a.id)).slice(0, 4);
  onMount(() => void loadInstallable());

  let empty: HTMLDivElement | undefined;
  createEffect(() => {
    if (store.restoringWorkspace || introduced) return;
    queueMicrotask(() => {
      if (introduced || !empty?.isConnected) return;
      introduced = true;
      [...empty.querySelectorAll<HTMLElement>(".empty-lead, .import-banner, .recent-chip")].slice(0, 4).forEach((element) => void reveal(element, 240));
    });
  });
  return (
    <div ref={empty} class="empty-state">
      <div class="empty-state-inner">
        <Show
          when={project()}
          fallback={<p class="empty-lead">Choose a project to start a session.</p>}
        >
          <p class="empty-lead">
            New session in <button class="empty-project" onClick={props.onOpenProjects}>{projectName(project()!)}</button>
          </p>
        </Show>

        <Show when={noAgents()}>
          <div class="empty-note">
            <div>No supported coding agent was found on your PATH. Install one to get started:</div>
            <div class="empty-install">
              <For each={suggestions()}>
                {(a) => (
                  <button class="recent-chip" disabled={installing().has(a.id)} onClick={() => void installAgent(a.id)}>
                    <Show when={installing().has(a.id)} fallback={<Icon name="download" size={13} />}><Spinner size={12} /></Show>
                    {a.name}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={pendingCandidates().length > 0}>
          <div class="import-banner">
            <button class="import-banner-main" onClick={() => setImportOpen(true)}>
              <Icon name="download" size={14} />
              Import {pendingCandidates().length} CLI session{pendingCandidates().length === 1 ? "" : "s"}
            </button>
            <button class="icon-btn" onClick={dismissBanner} title="Hide" aria-label="Hide import banner">
              <Icon name="x" size={13} />
            </button>
          </div>
        </Show>

        <div class="recent-row">
          <For each={recents()}>
            {(p) => (
              <button class="recent-chip" onClick={() => void openProjectPath(p.path)} title={p.path}>
                <Icon name="folder" size={13} />
                {p.name}
              </button>
            )}
          </For>
          <button class="recent-chip recent-chip-new" onClick={props.onNewProject}>
            <Icon name="plus" size={13} /> New project…
          </button>
        </div>
      </div>
    </div>
  );
};

export default EmptyState;
