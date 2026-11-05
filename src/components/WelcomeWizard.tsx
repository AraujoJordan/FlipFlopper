import { Component, For, Show, createSignal } from "solid-js";
import { Presence, Spinner } from "./ui";
import { Icon } from "./shell/Icon";
import { BrandMark } from "./shell/BrandMark";
import { AgentLogo } from "../lib/agentMeta";
import { store } from "../lib/store";
import { installAgent, installable, installing, loadInstallable } from "../lib/install";
import { candidates, scanImportable, scanning, setImportOpen } from "../lib/importer";
import { readPref, writePref } from "../lib/appPrefs";
import { runAction } from "../lib/shortcuts";

const DONE_KEY = "welcomeDone";
const [welcomeOpen, setWelcomeOpen] = createSignal(false);
export { welcomeOpen, setWelcomeOpen };

/** Open the first-run flow when this looks like a fresh install: no conversations, no recent projects, not dismissed before. */
export async function maybeShowWelcome(hasSessions: boolean, hasProjects: boolean) {
  if (hasSessions || hasProjects) return;
  if (await readPref<boolean>(DONE_KEY, false)) return;
  setWelcomeOpen(true);
}

const STEPS = ["Agents", "Projects", "Ready"] as const;

/** First run: see which agent CLIs are installed, bring in existing CLI conversations, and learn the essentials. */
const WelcomeWizard: Component = () => {
  const [step, setStep] = createSignal(0);
  const agents = () => store.agents.filter((a) => a.chat_supported);
  const finish = () => { writePref(DONE_KEY, true); setWelcomeOpen(false); setStep(0); };
  const goTo = (next: number) => {
    setStep(next);
    if (next === 0) void loadInstallable();
    if (next === 1) void scanImportable();
  };
  const found = () => agents().filter((a) => a.installed).length;

  return (
    <Presence when={welcomeOpen()}>
      <div class="overlay-backdrop-in" style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.55)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in" role="dialog" aria-label="Welcome to FlipFlopper" tabindex={-1}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") finish(); }}
          ref={(el) => queueMicrotask(() => { el.focus(); void loadInstallable(); })}
          style={{ width: "min(560px, 100%)", "max-height": "86vh", display: "flex", "flex-direction": "column", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)" }}>
          <div style={{ padding: "18px 22px 12px" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "10px", "font-size": "16px", "font-weight": "650", color: "var(--fg-default)" }}>
              <BrandMark size={26} />
              <span>Welcome to FlipFlopper</span>
            </div>
            <div style={{ display: "flex", gap: "6px", "margin-top": "12px" }} role="list" aria-label="Setup progress">
              <For each={STEPS}>{(name, i) => (
                <button type="button" role="listitem" onClick={() => goTo(i())} aria-current={step() === i() ? "step" : undefined}
                  style={{ flex: 1, padding: "5px 0 6px", "border-bottom": `2px solid ${i() <= step() ? "var(--accent)" : "var(--border-default)"}`, color: i() === step() ? "var(--fg-default)" : "var(--fg-subtle)", "font-size": "12px", "text-align": "left" }}>{i() + 1}. {name}</button>
              )}</For>
            </div>
          </div>
          <div style={{ padding: "6px 22px 14px", overflow: "auto", flex: 1, "font-size": "13px", color: "var(--fg-body)" }}>
            <Show when={step() === 0}>
              <p style={{ margin: "0 0 10px", color: "var(--fg-muted)" }}>FlipFlopper drives the coding agents already on your computer. {found() > 0 ? `${found()} found.` : "None found yet."} Each keeps its own sign-in; install any you want, then sign in from its CLI.</p>
              <For each={agents()}>{(a) => (
                <div style={{ display: "flex", "align-items": "center", gap: "10px", padding: "7px 0", "border-top": "1px solid var(--border-muted)" }}>
                  <AgentLogo agentId={a.id} icon={a.icon} size={20} radius={5} />
                  <span style={{ flex: 1 }}>{a.name}<Show when={a.installed && a.version}><span style={{ color: "var(--fg-subtle)", "margin-left": "8px", "font-size": "11.5px" }}>{a.version}</span></Show></span>
                  <Show when={a.installed} fallback={
                    <Show when={installable().has(a.id)} fallback={<span style={{ color: "var(--fg-subtle)", "font-size": "11.5px" }}>Not installed</span>}>
                      <button class="ui-btn ui-btn-outline" disabled={installing().has(a.id)} onClick={() => void installAgent(a.id)}>
                        <Show when={installing().has(a.id)}><Spinner size={12} /></Show> Install
                      </button>
                    </Show>}>
                    <span style={{ color: "var(--status-add)", display: "inline-flex", gap: "4px", "align-items": "center" }}><Icon name="check" size={14} /> Ready</span>
                  </Show>
                </div>
              )}</For>
            </Show>
            <Show when={step() === 1}>
              <p style={{ margin: "0 0 12px", color: "var(--fg-muted)" }}>Open the folder you want to work in, and bring over conversations you already had in Claude Code, Codex and other CLIs.</p>
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                <button class="ui-btn ui-btn-solid" onClick={() => { finish(); runAction("open-project"); }}><Icon name="folder" size={14} /> Open a project folder…</button>
                <button class="ui-btn ui-btn-outline" disabled={scanning() || candidates().length === 0} onClick={() => { finish(); setImportOpen(true); }}>
                  <Show when={scanning()} fallback={<Icon name="download" size={14} />}><Spinner size={12} /></Show>
                  {scanning() ? "Looking for CLI sessions…" : candidates().length > 0 ? `Import ${candidates().length} CLI session${candidates().length === 1 ? "" : "s"}…` : "No CLI sessions found"}
                </button>
              </div>
              <p style={{ margin: "12px 0 0", color: "var(--fg-subtle)", "font-size": "12px" }}>You can also start without a project: use “No project” on the new-session screen.</p>
            </Show>
            <Show when={step() === 2}>
              <p style={{ margin: "0 0 10px", color: "var(--fg-muted)" }}>A few things worth knowing:</p>
              <ul style={{ margin: 0, "padding-left": "18px", display: "flex", "flex-direction": "column", gap: "6px" }}>
                <li><b>⌘K</b> searches sessions, messages and actions. <b>⌘F</b> finds text in a conversation.</li>
                <li>Shift-click agents in the picker to run the same prompt on several, then compare.</li>
                <li><b>⌘S</b> stashes a draft, <b>⌘Z</b> undoes archive and pin, <b>/</b> lists commands.</li>
                <li>Press <b>?</b> any time for all keyboard shortcuts.</li>
              </ul>
            </Show>
          </div>
          <div style={{ display: "flex", gap: "8px", padding: "12px 22px", "border-top": "1px solid var(--border-muted)", "align-items": "center" }}>
            <button class="ui-btn ui-btn-ghost" onClick={finish}>Skip setup</button>
            <span style={{ flex: 1 }} />
            <Show when={step() > 0}><button class="ui-btn ui-btn-outline" onClick={() => goTo(step() - 1)}>Back</button></Show>
            <Show when={step() < STEPS.length - 1} fallback={<button class="ui-btn ui-btn-solid" onClick={finish}>Start working</button>}>
              <button class="ui-btn ui-btn-solid" onClick={() => goTo(step() + 1)}>Continue</button>
            </Show>
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default WelcomeWizard;
