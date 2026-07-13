import { Component, For, Show } from "solid-js";
import type { ProjectInfo } from "../lib/ipc";
import { Button, Spinner } from "./ui";

/** Modal opened from the title-bar project button. Surfaces
 *  `store.recentProjects` (previously fetched on every launch and never
 *  rendered anywhere) as an actual picker, plus "Open Folder…" for a new
 *  project. All IPC/state-mutation stays in App.tsx — this is a controlled
 *  view over it. Opening a project always opens it as a new project tab (or
 *  switches to its tab if already open). */
const ProjectPicker: Component<{
  open: boolean;
  onClose: () => void;
  busy: boolean;
  recents: ProjectInfo[];
  currentPath: string | null;
  onPickFolder: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
}> = (props) => {
  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <Show when={props.open}>
      <div
        class="overlay-backdrop-in"
        onclick={props.onClose}
        style={{
          position: "fixed", inset: 0, "z-index": "var(--z-modal)",
          background: "rgba(0,0,0,.48)",
          display: "flex", "align-items": "center", "justify-content": "center",
          padding: "24px",
        }}
      >
        <div
          class="overlay-pop-in"
          tabindex={-1}
          onclick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
          style={{
            width: "min(440px, 100%)",
            "max-height": "70vh",
            display: "flex", "flex-direction": "column",
            background: "var(--surface-3)",
            border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-xl)",
            "box-shadow": "var(--shadow-menu)",
            padding: "18px 20px",
          }}
        >
          <div style={{
            display: "flex", "align-items": "center", "justify-content": "space-between",
            "margin-bottom": "12px",
          }}>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)" }}>
              Open project
            </span>
            <Button variant="solid" size="sm" onClick={props.onPickFolder} disabled={props.busy}>
              <Show when={props.busy}><Spinner size={11} /></Show>
              Open Folder…
            </Button>
          </div>

          <Show
            when={props.recents.length > 0}
            fallback={
              <div style={{ "font-size": "12px", color: "var(--fg-subtle)", padding: "8px 0" }}>
                No recent projects yet — open a folder to get started.
              </div>
            }
          >
            <div style={{
              "font-size": "10.5px", "letter-spacing": ".5px", "text-transform": "uppercase",
              color: "var(--fg-subtle)", "font-weight": "600", margin: "4px 0 6px",
            }}>
              Recent
            </div>
            <div style={{ overflow: "auto", "flex-shrink": "1" }}>
              <For each={props.recents}>
                {(project) => (
                  <div
                    class="hover-tint"
                    style={{
                      display: "flex", "align-items": "center", gap: "10px",
                      padding: "8px 8px", "border-radius": "8px",
                      opacity: props.busy ? ".6" : "1",
                      "pointer-events": props.busy ? "none" : "auto",
                    }}
                  >
                    <button
                      type="button"
                      onclick={() => props.onOpenRecent(project.path)}
                      title={project.path}
                      style={{
                        flex: "1", "min-width": "0", "text-align": "left",
                        display: "flex", "flex-direction": "column", gap: "2px",
                      }}
                    >
                      <span style={{
                        "font-size": "12.5px", color: "var(--fg-default)",
                        display: "flex", "align-items": "center", gap: "6px",
                      }}>
                        {project.name}
                        <Show when={project.path === props.currentPath}>
                          <span style={{
                            "font-size": "9.5px", color: "var(--accent-soft)",
                            border: "1px solid var(--accent)66", "border-radius": "4px",
                            padding: "0 4px",
                          }}>
                            open
                          </span>
                        </Show>
                      </span>
                      <span style={{
                        "font-size": "11px", color: "var(--fg-subtle)",
                        overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
                      }}>
                        {project.path}
                      </span>
                    </button>
                    <button
                      class="icon-btn-danger press"
                      onclick={(e) => { e.stopPropagation(); props.onRemoveRecent(project.path); }}
                      title="Remove from recents"
                      aria-label={`Remove ${project.name} from recent projects`}
                      style={{
                        display: "flex", "align-items": "center", "justify-content": "center",
                        width: "22px", height: "22px", "flex-shrink": "0",
                        color: "var(--fg-subtle)", "border-radius": "var(--radius-sm)",
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default ProjectPicker;
