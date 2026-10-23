import { Component, For, Show, createSignal, onMount } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { chat, setComposer } from "../lib/chat";
import { layout, setTheme, setMotion, type MotionPref, type ThemePref } from "../lib/layout";
import { notifyOnFinish, setNotifyOnFinish } from "../lib/settings";
import { SHORTCUT_GROUPS } from "../lib/shortcuts";
import { store, addTerminal, setStore, effectiveRoot } from "../lib/store";
import { openSide } from "../lib/layout";
import { homeDir } from "@tauri-apps/api/path";
import { checkForUpdates, isUpdaterEnabled } from "../lib/updater";
import { AgentLogo } from "../lib/agentMeta";
import { agentRuntimeInfo, openTerminal, ptySendLine, getAgents, type AgentRuntimeInfo, type PermissionMode } from "../lib/ipc";
import { candidates, scanImportable, scanning, setImportOpen } from "../lib/importer";
import { installAgent, installable, installing, loadInstallable } from "../lib/install";
import { Checkbox, Spinner, toast, useValueMotion, useSelectionMotion } from "./ui";
import { Icon, type IconName } from "./shell/Icon";

type Section = "general" | "appearance" | "agents" | "shortcuts" | "about";

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "appearance", label: "Appearance", icon: "eye" },
  { id: "agents", label: "Agents", icon: "sparkle" },
  { id: "shortcuts", label: "Shortcuts", icon: "help" },
  { id: "about", label: "About", icon: "message" },
];

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "plan", label: "Plan", hint: "Read-only; proposes a plan" },
  { id: "auto_edit", label: "Auto-edit", hint: "Edits files without asking" },
  { id: "full", label: "Full access", hint: "Allows tools; native security policies still apply" },
];

const Row: Component<{ title: string; hint?: string; children: any }> = (props) => (
  <div class="settings-row">
    <div class="settings-row-text">
      <div class="settings-row-title">{props.title}</div>
      <Show when={props.hint}><div class="settings-row-hint">{props.hint}</div></Show>
    </div>
    <div class="settings-row-control">{props.children}</div>
  </div>
);

/** Settings window: left nav (General · Appearance · Agents · Shortcuts · About). */
const SettingsPanel: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const [section, setSection] = createSignal<Section>("general");
  let content: HTMLDivElement | undefined;
  let navigation: HTMLElement | undefined;
  useValueMotion(() => content, section);
  useSelectionMotion(() => navigation, section, ".settings-nav-on");
  const [version, setVersion] = createSignal("");
  const [runtimes, setRuntimes] = createSignal<Record<string, AgentRuntimeInfo>>({});
  const [refreshingAgents, setRefreshingAgents] = createSignal(false);
  async function refreshAgents() {
    setRefreshingAgents(true);
    try {
      const [agents, claude, cursor] = await Promise.all([getAgents(true), agentRuntimeInfo("claude"), agentRuntimeInfo("cursor")]);
      setStore("agents", agents); setRuntimes({ claude, cursor });
    } catch (error) { toast(String(error), "error"); }
    finally { setRefreshingAgents(false); }
  }
  async function cliAction(agentId: string, action: "login" | "update") {
    try {
      const cwd = effectiveRoot() ?? await homeDir();
      const terminal = await openTerminal(cwd);
      addTerminal({ sessionId: terminal, label: `${action === "login" ? "Sign in" : "Update"} · ${agentId === "claude" ? "Claude Code" : "Cursor"}`, kind: "shell" });
      openSide("terminal"); props.onClose();
      const command = agentId === "claude" ? action === "login" ? "claude auth login" : "claude update" : action === "login" ? "cursor-agent login" : "cursor-agent update";
      await ptySendLine(terminal, command);
    } catch (error) { toast(`Could not open CLI sign-in: ${String(error)}`, "error"); }
  }
  onMount(() => {
    void getVersion().then(setVersion).catch(() => {});
    void loadInstallable();
    void refreshAgents();
  });

  async function checkUpdates() {
    if (!isUpdaterEnabled()) {
      toast("Update with Homebrew: brew upgrade flipflopper");
      return;
    }
    try {
      toast((await checkForUpdates()) ? "An update is available" : "You're up to date");
    } catch (e) {
      toast(`Update check failed: ${String(e)}`, "error");
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
  }

  return (
    <Show when={props.open}>
      <div class="overlay-backdrop-in settings-backdrop" onClick={props.onClose}>
        <div class="overlay-pop-in settings" tabIndex={-1} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <nav ref={navigation} class="settings-nav">
            <div class="settings-nav-title">Settings</div>
            <For each={SECTIONS}>
              {(s) => (
                <button class="settings-nav-item" classList={{ "settings-nav-on": section() === s.id }} onClick={() => setSection(s.id)}>
                  <Icon name={s.icon} size={15} /> {s.label}
                </button>
              )}
            </For>
          </nav>

          <div ref={content} class="settings-body">
            <button class="icon-btn settings-close" onClick={props.onClose} title="Close" aria-label="Close settings">
              <Icon name="x" size={16} />
            </button>

            <Show when={section() === "general"}>
              <h2>General</h2>
              <Row title={chat.activeId ? "Session permissions" : "Default permissions"} hint={chat.activeId ? "Changes this conversation. Native agents update live; other running CLIs apply the change next turn." : "Used for new sessions. You can change it per session from the composer."}>
                <div class="seg">
                  <For each={MODES}>
                    {(m) => (
                      <button
                        class="seg-btn"
                        classList={{ "seg-on": chat.composer.mode === m.id }}
                        title={m.hint}
                        onClick={() => setComposer({ mode: m.id })}
                      >
                        {m.label}
                      </button>
                    )}
                  </For>
                </div>
              </Row>
              <Row title="Import CLI sessions" hint="Bring existing Claude Code and Codex terminal sessions for your projects into FlipFlopper.">
                <button
                  class="ui-btn ui-btn-outline settings-btn"
                  onClick={async () => { await scanImportable(); props.onClose(); setImportOpen(true); }}
                  disabled={scanning()}
                >
                  {scanning() ? "Scanning…" : candidates().length > 0 ? `Review ${candidates().length} sessions…` : "Scan for sessions"}
                </button>
              </Row>
              <Row title="Notifications" hint="Get a system notification when a session finishes while you're looking elsewhere.">
                <Checkbox checked={notifyOnFinish()} onChange={setNotifyOnFinish} label="Notify when a session finishes" />
              </Row>
            </Show>

            <Show when={section() === "appearance"}>
              <h2>Appearance</h2>
              <Row title="Theme" hint="System follows your OS appearance.">
                <div class="seg">
                  <For each={THEMES}>
                    {(t) => (
                      <button class="seg-btn" classList={{ "seg-on": layout.theme === t.id }} onClick={() => setTheme(t.id)}>
                        {t.label}
                      </button>
                    )}
                  </For>
                </div>
              </Row>
            </Show>

            <Show when={section() === "appearance"}>
              <Row title="Motion" hint="System follows your OS. Reduced keeps brief fades; Off settles immediately.">
                <div class="seg" role="group" aria-label="Motion">
                  <For each={["system", "reduced", "off"] as MotionPref[]}>
                    {(m) => <button class="seg-btn" aria-pressed={layout.motion === m} classList={{ "seg-on": layout.motion === m }} onClick={() => setMotion(m)}>{m[0].toUpperCase() + m.slice(1)}</button>}
                  </For>
                </div>
              </Row>
            </Show>

            <Show when={section() === "agents"}>
              <h2>Agents</h2>
              <p class="settings-lead">
                Claude Code and Cursor use persistent native agent sessions with interactive approvals. Other supported CLIs use their headless mode. Each agent keeps its existing login, MCP servers, rules and settings.
              </p>
              <button class="ui-btn ui-btn-outline settings-btn" disabled={refreshingAgents()} onClick={() => void refreshAgents()}>{refreshingAgents() ? "Checking…" : "Refresh agent readiness"}</button>
              <div class="agent-list">
                <For each={store.agents}>
                  {(a) => (
                    <div class="agent-item" data-ready={a.installed}>
                      <AgentLogo agentId={a.id} icon={a.icon} size={28} radius={7} />
                      <div class="agent-item-text">
                        <div class="agent-item-name">{a.name}</div>
                        <div class="agent-item-sub">{a.installed ? (a.version ?? "Installed") : "Not installed"}</div>
                        <Show when={runtimes()[a.id]}>{(runtime) => <div class="agent-item-sub">{runtime().detail}<Show when={runtime().node_version}> · Node {runtime().node_version} · Claude helper {runtime().helper_version}</Show></div>}</Show>
                        <Show when={a.installed && (a.id === "claude" || a.id === "cursor")}><button class="ui-btn ui-btn-ghost settings-btn" onClick={() => void cliAction(a.id, "login")}>Sign in through CLI…</button><button class="ui-btn ui-btn-ghost settings-btn" onClick={() => void cliAction(a.id, "update")}>Update CLI…</button></Show>
                      </div>
                      <Show
                        when={!a.installed && installable().has(a.id)}
                        fallback={
                          <span class="agent-tag" classList={{ "agent-tag-on": a.installed && a.chat_supported }}>
                            {!a.chat_supported ? "Terminal only" : a.installed ? runtimes()[a.id]?.available === false ? "Runtime unavailable" : "Installed" : "Unavailable"}
                          </span>
                        }
                      >
                        <button class="ui-btn ui-btn-outline settings-btn" disabled={installing().has(a.id)} onClick={() => void installAgent(a.id)}>
                          <Show when={installing().has(a.id)} fallback="Install"><Spinner size={12} /> Installing…</Show>
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={section() === "shortcuts"}>
              <h2>Keyboard shortcuts</h2>
              <For each={SHORTCUT_GROUPS}>
                {(group) => (
                  <div class="shortcut-group">
                    <div class="shortcut-group-title">{group.label}</div>
                    <For each={group.items}>
                      {(item) => (
                        <div class="shortcut-row">
                          <span>{item.description}</span>
                          <kbd>{item.keys}</kbd>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>

            <Show when={section() === "about"}>
              <h2>About</h2>
              <Row title="FlipFlopper" hint={version() ? `Version ${version()}` : undefined}>
                <button class="ui-btn ui-btn-outline settings-btn" onClick={() => void checkUpdates()}>Check for updates</button>
              </Row>
              <Show when={!isUpdaterEnabled()}>
                <p class="settings-lead">On macOS, update with Homebrew: <code>brew upgrade flipflopper</code>.</p>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default SettingsPanel;
