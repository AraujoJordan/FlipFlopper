import { Component, For, Show, createEffect, createSignal } from "solid-js";
import { Presence, confirmDialog, toast } from "./ui";
import { Icon } from "./shell/Icon";
import { archiveSessions, chat, projectName, startNewSession } from "../lib/chat";
import { store } from "../lib/store";
import { clearProjectDefaults, projectDefaults, setProjectDefaults } from "../lib/projectDefaults";
import {
  isProjectPinned, layout, projectMonogram, setProjectDisplayName, setProjectIcon, toggleProjectPin, type ProjectIcon,
} from "../lib/layout";
import { openProjectPath, removeSidebarProject } from "../lib/projects";
import { openIn, quickEditor } from "../lib/openIn";
import { writeClipboardText } from "../lib/native";
import { pickFiles, publishRepository } from "../lib/ipc";
import { projectAutoPullOverride, setProjectAutoPull } from "../lib/autoPull";
import { defaultRepositoryName, isValidRepositoryName } from "../lib/repoUrl";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import ProjectIconView from "./ProjectIconView";

/** T3's project icon palette: monogram hues that stay readable with white text. */
const MONOGRAM_HUES = [165, 195, 225, 255, 290, 330, 12, 42];

const [request, setRequest] = createSignal<string | null>(null);
export { request as projectSettingsPath };
/** Open Settings-style details for one project (name, monogram, pin, location). */
export function openProjectSettings(path: string) {
  if (path) setRequest(path);
}

/** Project settings: a display name, a monogram override, pinning, location and removal. */
const ProjectSettingsDialog: Component = () => {
  const path = () => request();
  const name = () => (path() ? projectName(path()!) : "");
  const [draftName, setDraftName] = createSignal("");
  const [publishName, setPublishName] = createSignal("");
  const [publishPrivate, setPublishPrivate] = createSignal(true);
  const [publishDescription, setPublishDescription] = createSignal("");
  const [publishing, setPublishing] = createSignal(false);
  const [publishError, setPublishError] = createSignal<string | null>(null);
  const [letter, setLetter] = createSignal("");
  const [hue, setHue] = createSignal<number | null>(null);
  const [image, setImage] = createSignal<string | null>(null);
  const close = () => setRequest(null);

  // A new project starts from its saved alias/icon; edits below apply immediately.
  createEffect(() => {
    const current = path();
    if (!current) return;
    setDraftName(projectName(current));
    setPublishName(defaultRepositoryName(projectName(current)));
    setPublishError(null);
    const saved = layout.projectIcons[current];
    setLetter(saved?.letter ?? "");
    setHue(saved?.hue ?? null);
    setImage(saved?.image ?? null);
  });

  const preview = () => projectMonogram(draftName().trim() || name() || "Project", {
    ...(letter().trim() ? { letter: letter().trim() } : {}),
    ...(hue() !== null ? { hue: hue()! } : {}),
    ...(image() ? { image: image()! } : {}),
  });
  const defaults = () => projectDefaults(path());
  const usesDefaults = () => Object.keys(defaults()).length > 0;

  function saveIcon(next: ProjectIcon | null) {
    const current = path();
    if (!current) return;
    setProjectIcon(current, next);
    const saved = layout.projectIcons[current];
    setLetter(saved?.letter ?? "");
    setHue(saved?.hue ?? null);
    setImage(saved?.image ?? null);
  }

  async function chooseImage() {
    try {
      const picked = await pickFiles();
      const file = picked.find((entry) => entry.kind === "image" || /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(entry.path));
      if (!file) {
        if (picked.length) toast("Choose an image file (PNG, JPEG, GIF, WebP, AVIF, BMP or ICO).", "error");
        return;
      }
      saveIcon({
        ...(letter().trim() ? { letter: letter().trim() } : {}),
        ...(hue() !== null ? { hue: hue()! } : {}),
        image: file.path,
      });
    } catch (error) {
      toast(`Couldn't choose an image: ${String(error)}`, "error");
    }
  }

  async function publish() {
    const current = path();
    if (!current || publishing()) return;
    if (!isValidRepositoryName(publishName())) {
      setPublishError("Use letters, digits, dots, underscores and hyphens (max 100); the name cannot start with '-' or '.'.");
      return;
    }
    const approved = await confirmDialog(`Create the ${publishPrivate() ? "private" : "PUBLIC"} GitHub repository “${publishName().trim()}” and push this project's current branch?`, "Publish to GitHub");
    if (!approved) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const url = await publishRepository(current, publishName().trim(), publishPrivate(), publishDescription().trim() || undefined);
      toast(url ? `Published to GitHub: ${url}` : "Repository published to GitHub.", "success");
      if (url) void writeClipboardText(url, "repository URL").catch(() => {});
    } catch (error) {
      setPublishError(String(error));
    } finally {
      setPublishing(false);
    }
  }

  function saveName() {
    const current = path();
    if (!current) return;
    setProjectDisplayName(current, draftName());
    setDraftName(projectName(current));
    toast(draftName().trim() ? "Project renamed in the sidebar." : "Project name reset to its folder.", "success");
  }

  return (
    <Presence when={path() !== null}>
      <div class="overlay-backdrop-in" onClick={close}
        style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.48)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in project-settings" role="dialog" aria-modal="true" aria-label="Project settings" tabindex={-1}
          onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") close(); }}
          ref={(el) => queueMicrotask(() => el.focus())}>
          <header class="project-settings-head">
            <ProjectIconView name={draftName().trim() || name() || "Project"} icon={preview()} class="project-settings-preview" />
            <div class="project-settings-heading">
              <strong>Project settings{isProjectPinned(path() ?? "") ? " · Pinned" : ""}</strong>
              <span title={path() ?? undefined}>{name() || "Project"} · {chat.sessions.filter((session) => session.project_path === path()).length} session{chat.sessions.filter((session) => session.project_path === path()).length === 1 ? "" : "s"}</span>
            </div>
            <button class="icon-btn press" onClick={close} title="Close" aria-label="Close project settings"><Icon name="x" size={14} /></button>
          </header>

          <div class="project-settings-body">
            <section class="project-settings-section" aria-label="Name">
              <div class="project-settings-label">Name</div>
              <div class="project-settings-row">
                <input class="ui-field" style={{ flex: 1 }} aria-label="Project display name" maxLength={80} value={draftName()}
                  placeholder={name()} onInput={(event) => setDraftName(event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveName(); } }} />
                <button type="button" class="ui-btn ui-btn-outline" onClick={saveName} disabled={draftName().trim() === name()}>Save</button>
                <Show when={layout.projectNames[path() ?? ""]}>
                  <button type="button" class="ui-btn ui-btn-ghost" onClick={() => { setProjectDisplayName(path()!, ""); setDraftName(name()); }}>Reset</button>
                </Show>
              </div>
              <div class="project-settings-hint">Only changes the name shown in FlipFlopper; the folder on disk keeps its name.</div>
            </section>

            <section class="project-settings-section" aria-label="Icon">
              <div class="project-settings-label">Icon</div>
              <div class="project-settings-row">
                <input class="ui-field project-settings-letter" aria-label="Monogram letters" maxLength={4} placeholder={preview().letter} value={letter()}
                  onInput={(event) => setLetter(event.currentTarget.value)}
                  onChange={() => saveIcon({ ...(letter().trim() ? { letter: letter().trim() } : {}), ...(hue() !== null ? { hue: hue()! } : {}) })} />
                <span class="project-settings-hint" style={{ flex: 1 }}>One or two letters, numbers or emoji.</span>
                <button type="button" class="ui-btn ui-btn-ghost" onClick={() => saveIcon(null)} disabled={!letter().trim() && hue() === null && !image()}>Automatic</button>
              </div>
              <div class="project-settings-row project-settings-actions">
                <button type="button" class="ui-btn ui-btn-outline" onClick={() => void chooseImage()}>
                  <Icon name="image" size={13} /> Choose image…
                </button>
                <Show when={image()}>
                  <button type="button" class="ui-btn ui-btn-ghost" onClick={() => saveIcon({
                    ...(letter().trim() ? { letter: letter().trim() } : {}),
                    ...(hue() !== null ? { hue: hue()! } : {}),
                  })}>Remove image</button>
                </Show>
              </div>
              <div class="project-settings-hint">A local image is shown in the sidebar and this header. Letters, numbers and emoji still work.</div>
              <div class="project-settings-swatches" role="group" aria-label="Monogram color">
                <For each={MONOGRAM_HUES}>
                  {(value) => (
                    <button type="button" class="project-settings-swatch" aria-label={`Monogram color ${value}`} aria-pressed={hue() === value}
                      title={`Color ${value}`} onClick={() => saveIcon({ ...(letter().trim() ? { letter: letter().trim() } : {}), hue: value })}
                      style={{ background: `hsl(${value} 55% 42%)`, outline: hue() === value ? "2px solid var(--fg-default)" : "none" }} />
                  )}
                </For>
              </div>
            </section>

            <section class="project-settings-section" aria-label="Location">
              <div class="project-settings-label">Location</div>
              <div class="project-settings-row">
                <Icon name="folder" size={14} />
                <span class="project-settings-path" title={path() ?? undefined}>{path()}</span>
              </div>
              <div class="project-settings-row project-settings-actions">
                <button type="button" class="ui-btn ui-btn-outline" onClick={() => void writeClipboardText(path()!, "project path").catch((error) => toast(String(error), "error"))}>Copy path</button>
                <button type="button" class="ui-btn ui-btn-outline" onClick={() => void revealItemInDir(path()!).catch((error) => toast(`Couldn't reveal the folder: ${String(error)}`, "error"))}>Reveal folder</button>
                <Show when={quickEditor()}>
                  {(editor) => <button type="button" class="ui-btn ui-btn-outline" onClick={() => void openIn(editor().id, path()!)}>Open in {editor().name}</button>}
                </Show>
              </div>
            </section>

            <section class="project-settings-section" aria-label="New session defaults">
              <div class="project-settings-label">New session defaults</div>
              <div class="project-settings-row">
                <label class="project-settings-field" style={{ flex: 1 }}>
                  <span>Agent</span>
                  <select class="ui-field" aria-label="Default agent" value={defaults().agentId ?? ""}
                    onChange={(event) => setProjectDefaults(path()!, { agentId: event.currentTarget.value || undefined, model: null, effort: null })}>
                    <option value="">App default</option>
                    <For each={store.agents.filter((agent) => agent.installed)}>{(agent) => <option value={agent.id}>{agent.name}</option>}</For>
                  </select>
                </label>
                <label class="project-settings-field" style={{ flex: 1 }}>
                  <span>Model</span>
                  <input class="ui-field" aria-label="Default model" placeholder="Agent default" value={defaults().model ?? ""}
                    onChange={(event) => setProjectDefaults(path()!, { model: event.currentTarget.value.trim() || null })} />
                </label>
              </div>
              <div class="project-settings-row">
                <label class="project-settings-field" style={{ flex: 1 }}>
                  <span>Permissions</span>
                  <select class="ui-field" aria-label="Default permission mode" value={defaults().mode ?? ""}
                    onChange={(event) => setProjectDefaults(path()!, { mode: (event.currentTarget.value || undefined) as any })}>
                    <option value="">App default</option>
                    <option value="manual">Manual</option>
                    <option value="auto_edit">Auto-edit</option>
                    <option value="plan">Plan</option>
                    <option value="ask">Ask</option>
                  </select>
                </label>
                <label class="project-settings-field" style={{ flex: 1 }}>
                  <span>Workspace</span>
                  <select class="ui-field" aria-label="Default workspace" value={defaults().worktree === undefined ? "" : defaults().worktree ? "worktree" : "local"}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setProjectDefaults(path()!, { worktree: value === "" ? undefined : value === "worktree" });
                    }}>
                    <option value="">App default</option>
                    <option value="local">Local checkout</option>
                    <option value="worktree">Isolated worktree</option>
                  </select>
                </label>
              </div>
              <Show when={defaults().worktree}>
                <div class="project-settings-row">
                  <label class="project-settings-field" style={{ flex: 1 }}>
                    <span>Worktree base branch</span>
                    <input class="ui-field" aria-label="Default worktree base branch" placeholder="Current branch" value={defaults().worktreeBase ?? ""}
                      onChange={(event) => setProjectDefaults(path()!, { worktreeBase: event.currentTarget.value.trim() || null })} />
                  </label>
                </div>
              </Show>
              <div class="project-settings-row project-settings-actions">
                <button type="button" class="ui-btn ui-btn-ghost" disabled={!usesDefaults()} onClick={() => clearProjectDefaults(path()!)}>
                  <Icon name="refresh" size={13} /> Use app defaults
                </button>
              </div>
              <div class="project-settings-hint">Applied when a new session starts in this project. A choice made in the composer still wins for the current draft.</div>
            </section>

            <section class="project-settings-section" aria-label="Sidebar">
              <div class="project-settings-label">Sidebar</div>
              <div class="project-settings-row project-settings-actions">
                <button type="button" class="ui-btn ui-btn-outline" onClick={() => toggleProjectPin(path()!)}>
                  <Icon name="sparkle" size={13} /> {isProjectPinned(path()!) ? "Unpin project" : "Pin project"}
                </button>
                <button type="button" class="ui-btn ui-btn-outline" disabled={chat.sessions.filter((session) => session.project_path === path() && !session.archived).length === 0}
                  onClick={() => {
                    const current = path();
                    if (!current) return;
                    const ids = chat.sessions.filter((session) => session.project_path === current && !session.archived).map((session) => session.id);
                    close();
                    void archiveSessions(ids, true);
                  }}>
                  <Icon name="archive" size={13} /> Archive sessions ({chat.sessions.filter((session) => session.project_path === path() && !session.archived).length})
                </button>
                <Show when={chat.sessions.some((session) => session.project_path === path() && session.archived)}>
                  <button type="button" class="ui-btn ui-btn-ghost" onClick={() => {
                    const current = path();
                    if (!current) return;
                    const ids = chat.sessions.filter((session) => session.project_path === current && session.archived).map((session) => session.id);
                    close();
                    void archiveSessions(ids, false);
                  }}>
                    <Icon name="refresh" size={13} /> Restore archived
                  </button>
                </Show>
                <button type="button" class="ui-btn ui-btn-ghost" style={{ color: "var(--status-del)" }}
                  onClick={() => { const current = path()!; close(); void removeSidebarProject(current); }}>
                  <Icon name="trash" size={13} /> Remove from sidebar…
                </button>
              </div>
              <div class="project-settings-hint">Pinned projects sort first. Removing keeps files and conversations; open the folder again to restore it.</div>
            </section>
          </div>

            <section class="project-settings-section" aria-label="Source control">
              <div class="project-settings-label">Source control</div>
              <div class="project-settings-row">
                <span class="project-settings-hint" style={{ flex: 1 }}>Automatically pull on open</span>
                <select class="ui-field" style={{ width: "140px" }} aria-label="Automatic pull for this project"
                  value={projectAutoPullOverride(path()) === null ? "inherit" : projectAutoPullOverride(path()) ? "on" : "off"}
                  onChange={(event) => { const current = path(); if (!current) return; const value = event.currentTarget.value; setProjectAutoPull(current, value === "inherit" ? null : value === "on"); }}>
                  <option value="inherit">Use default</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <div class="project-settings-hint">Only fast-forwards a clean checkout with no local commits; never merges or stashes.</div>
            </section>

            <section class="project-settings-section" aria-label="Publish">
              <div class="project-settings-label">Publish</div>
              <div class="project-settings-row">
                <input class="ui-field" style={{ flex: 1, "min-width": "170px" }} aria-label="GitHub repository name" maxLength={100} value={publishName()}
                  onInput={(event) => { setPublishName(event.currentTarget.value); setPublishError(null); }} />
                <div class="seg" role="group" aria-label="Repository visibility">
                  <button type="button" class="seg-btn" aria-pressed={publishPrivate()} classList={{ "seg-on": publishPrivate() }} onClick={() => setPublishPrivate(true)}>Private</button>
                  <button type="button" class="seg-btn" aria-pressed={!publishPrivate()} classList={{ "seg-on": !publishPrivate() }} onClick={() => setPublishPrivate(false)}>Public</button>
                </div>
              </div>
              <input class="ui-field" aria-label="Repository description" placeholder="Description (optional)" maxLength={200}
                value={publishDescription()} onInput={(event) => setPublishDescription(event.currentTarget.value)} />
              <div class="project-settings-row project-settings-actions">
                <button type="button" class="ui-btn ui-btn-outline" disabled={publishing()} onClick={() => void publish()}>
                  <Icon name="upload" size={13} /> {publishing() ? "Publishing…" : "Publish to GitHub…"}
                </button>
              </div>
              <div class="project-settings-hint">Uses the GitHub CLI signed in on this machine: creates the repository, adds origin and pushes the current branch. Projects that already have an origin are refused.</div>
              <Show when={publishError()}>{(message) => <span class="model-price-error" role="alert">{message()}</span>}</Show>
            </section>

          <footer class="project-settings-foot" style={{ gap: "8px" }}>
            <button type="button" class="ui-btn ui-btn-outline" onClick={() => { const current = path(); close(); if (current) void openProjectPath(current); }}>Open project</button>
            <button type="button" class="ui-btn ui-btn-outline" onClick={() => { const current = path(); close(); if (current) startNewSession(current); }}>New session here</button>
            <span style={{ flex: 1 }} />
            <button type="button" class="ui-btn ui-btn-solid" onClick={close}>Done</button>
          </footer>
        </div>
      </div>
    </Presence>
  );
};

export default ProjectSettingsDialog;
