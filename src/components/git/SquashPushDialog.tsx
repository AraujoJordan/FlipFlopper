import { Component, For, Show, createSignal, createEffect } from "solid-js";
import { store, bumpGitStatus, rankContinueCandidates, updateCurrentBranch } from "../../lib/store";
import {
  gitPush, squashUnpushed, generateCommitMessage,
  type AgentInfo, type CommitEntry,
} from "../../lib/ipc";
import { AgentLogo } from "../../App";
import { Button, Menu, MenuItem, Spinner, toast } from "../ui";

interface SquashPushState {
  commits: CommitEntry[];
  isPublish: boolean;
}

const [state, setState] = createSignal<SquashPushState | null>(null);

/** Show the "squash unpushed commits before publishing" dialog. Called from
 *  SyncHeader's push handler when there are 2+ unpushed commits (or 1+ on a
 *  first publish). */
export function openSquashPushDialog(s: SquashPushState) {
  setState(s);
}

/** Sparkle mark for the AI generate action. */
const SparkleIcon: Component<{ size?: number }> = (props) => (
  <svg
    width={props.size ?? 13} height={props.size ?? 13} viewBox="0 0 24 24"
    fill="currentColor" style={{ "flex-shrink": "0" }}
  >
    <path d="M9 3l1.4 3.9L14.3 8.3l-3.9 1.4L9 13.6 7.6 9.7 3.7 8.3l3.9-1.4z" />
    <path d="M17.5 13l.85 2.35L20.7 16.2l-2.35.85L17.5 19.4l-.85-2.35L14.3 16.2l2.35-.85z" />
  </svg>
);

export const SquashPushDialogHost: Component = () => {
  const [name, setName] = createSignal("");
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [selectedAgentId, setSelectedAgentId] = createSignal<string | null>(null);
  const [generating, setGenerating] = createSignal(false);
  const [busy, setBusy] = createSignal<"squash" | "plain" | null>(null);
  const [focused, setFocused] = createSignal(false);
  let pickerAnchor: HTMLButtonElement | undefined;

  // Prefill the name with the newest unpushed commit's subject as a starting
  // point every time the dialog opens for a new set of commits.
  createEffect(() => {
    const s = state();
    if (s) setName(s.commits[0]?.message ?? "");
  });

  const candidates = (): AgentInfo[] =>
    rankContinueCandidates(store.currentProject?.path ?? "", "", store.agents, false)
      .filter((agent) => agent.headless_supported);

  const selectedAgent = (): AgentInfo | undefined => {
    const id = selectedAgentId();
    const list = candidates();
    return (id ? list.find((a) => a.id === id) : undefined) ?? list[0];
  };

  const canGenerate = () => !!selectedAgent() && !generating() && busy() === null;

  function close() {
    setState(null);
    setName("");
    setSelectedAgentId(null);
    setPickerOpen(false);
    setGenerating(false);
    setBusy(null);
    setFocused(false);
  }

  async function generate() {
    const project = store.currentProject;
    const agent = selectedAgent();
    if (!project || !agent) return;
    setGenerating(true);
    try {
      const message = await generateCommitMessage(project.path, agent.id);
      setName(message);
    } catch (e) {
      toast(`Failed to generate a commit message: ${String(e)}`, "error");
    } finally {
      setGenerating(false);
    }
  }

  async function afterPush(message: string) {
    bumpGitStatus();
    await updateCurrentBranch();
    toast(message, "success");
    close();
  }

  async function squashAndPush() {
    const project = store.currentProject;
    const trimmed = name().trim();
    if (!project || !trimmed) return;
    setBusy("squash");
    try {
      await squashUnpushed(project.path, trimmed);
      const msg = await gitPush(project.path);
      await afterPush(msg);
    } catch (e) {
      toast(`Failed to squash and push: ${String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function pushWithoutSquashing() {
    const project = store.currentProject;
    if (!project) return;
    setBusy("plain");
    try {
      const msg = await gitPush(project.path);
      await afterPush(msg);
    } catch (e) {
      toast(`Failed to push: ${String(e)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Show when={state()}>
      {(s) => (
        <div
          onclick={close}
          style={{
            // Below Menu's z-index (150) — the agent-picker dropdown is a
            // Portal rendered as a sibling in the DOM, so it must stack
            // above this backdrop to stay clickable.
            position: "fixed", inset: 0, "z-index": "140",
            display: "flex", "align-items": "center", "justify-content": "center",
            background: "rgba(0,0,0,.5)",
          }}
        >
          <div
            onclick={(e) => e.stopPropagation()}
            style={{
              width: "440px",
              background: "var(--surface-3)",
              border: "1px solid var(--border-default)",
              "border-radius": "var(--radius-xl)",
              "box-shadow": "0 24px 60px rgba(0,0,0,.65)",
              padding: "20px",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", "align-items": "center", gap: "9px", "margin-bottom": "5px" }}>
              <div style={{
                display: "flex", "align-items": "center", "justify-content": "center",
                width: "26px", height: "26px", "flex-shrink": "0",
                "border-radius": "var(--radius-md)",
                background: "var(--surface-4)", color: "var(--accent)",
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </div>
              <div style={{ "font-size": "14px", color: "var(--fg-default)", "font-weight": "600" }}>
                {s().isPublish ? "Publish branch to origin" : "Push to origin"}
              </div>
            </div>
            <div style={{ "font-size": "12px", color: "var(--fg-muted)", "line-height": "1.5", "margin-bottom": "13px", "padding-left": "35px" }}>
              Squash into one commit before pushing, or push as-is. Nothing already on origin is rewritten.
            </div>

            {/* Commits that will be squashed */}
            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px" }}>
              <span style={{ "font-size": "11px", "font-weight": "600", color: "var(--fg-subtle)", "text-transform": "uppercase", "letter-spacing": ".04em" }}>
                Commits not on origin
              </span>
              <span style={{
                "font-size": "10.5px", "font-weight": "600", color: "var(--accent)",
                background: "var(--surface-4)", padding: "1px 7px", "border-radius": "999px",
              }}>
                {s().commits.length} → 1
              </span>
            </div>
            <div style={{
              "max-height": "132px", overflow: "auto",
              background: "var(--surface-1)", border: "1px solid var(--border-muted)",
              "border-radius": "var(--radius-md)", "margin-bottom": "16px",
            }}>
              <For each={s().commits}>
                {(c, i) => (
                  <div style={{
                    display: "flex", "align-items": "baseline", gap: "9px",
                    padding: "6px 10px",
                    "border-top": i() === 0 ? "none" : "1px solid var(--border-muted)",
                  }}>
                    <span style={{ "font-family": "var(--font-mono)", "font-size": "10.5px", color: "var(--accent)", "flex-shrink": "0" }}>
                      {c.short_sha}
                    </span>
                    <span style={{
                      "font-size": "12px", color: "var(--fg-body)",
                      "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis",
                    }}>
                      {c.message}
                    </span>
                  </div>
                )}
              </For>
            </div>

            {/* New commit message + AI generate */}
            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "6px", "min-height": "24px" }}>
              <span style={{ "font-size": "11px", "font-weight": "600", color: "var(--fg-subtle)", "text-transform": "uppercase", "letter-spacing": ".04em" }}>
                New commit message
              </span>

              {/* Segmented AI control: [agent ▾ | ✦ Generate] */}
              <Show
                when={candidates().length > 0}
                fallback={
                  <span style={{ "font-size": "11px", color: "var(--fg-faint)" }} title="No installed agent supports headless generation">
                    No AI agent available
                  </span>
                }
              >
                <div style={{
                  display: "flex", "align-items": "stretch",
                  border: "1px solid var(--border-default)", "border-radius": "var(--radius-md)",
                  overflow: "hidden", background: "var(--surface-4)",
                }}>
                  <button
                    ref={pickerAnchor}
                    onclick={() => setPickerOpen((o) => !o)}
                    disabled={busy() !== null || generating()}
                    title={selectedAgent()?.name}
                    style={{
                      display: "flex", "align-items": "center", gap: "5px",
                      padding: "0 7px", background: "transparent", border: "none",
                      "border-right": "1px solid var(--border-default)",
                      color: "var(--fg-default)",
                      cursor: busy() !== null || generating() ? "default" : "pointer",
                    }}
                  >
                    <Show when={selectedAgent()}>
                      {(agent) => <AgentLogo agentId={agent().id} icon={agent().icon} name={agent().name} size={15} radius={4} />}
                    </Show>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--fg-subtle)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>

                  <button
                    onclick={generate}
                    disabled={!canGenerate()}
                    style={{
                      display: "flex", "align-items": "center", gap: "6px",
                      padding: "6px 11px", background: "transparent", border: "none",
                      "font-size": "11.5px", "font-weight": "600",
                      color: canGenerate() ? "var(--accent-soft)" : "var(--fg-faint)",
                      cursor: canGenerate() ? "pointer" : "default",
                    }}
                  >
                    <Show when={generating()} fallback={<SparkleIcon />}>
                      <Spinner size={12} />
                    </Show>
                    {generating() ? "Generating…" : "Generate with AI"}
                  </button>
                </div>

                <Menu open={pickerOpen()} onClose={() => setPickerOpen(false)} anchorRef={pickerAnchor} align="right" width={220}>
                  <For each={candidates()}>
                    {(agent) => (
                      <MenuItem onSelect={() => { setSelectedAgentId(agent.id); setPickerOpen(false); }}>
                        <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} size={16} radius={4} />
                        <span style={{ flex: "1", "font-size": "12.5px" }}>{agent.name}</span>
                        <Show when={selectedAgent()?.id === agent.id}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        </Show>
                      </MenuItem>
                    )}
                  </For>
                </Menu>
              </Show>
            </div>

            <input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Describe the squashed commit…"
              spellcheck={false}
              style={{
                width: "100%", "box-sizing": "border-box",
                padding: "9px 11px", "margin-bottom": "18px",
                background: "var(--surface-1)",
                border: `1px solid ${focused() ? "var(--accent)" : "var(--border-default)"}`,
                "box-shadow": focused() ? "0 0 0 3px rgba(88,166,255,.15)" : "none",
                outline: "none", transition: "border-color .12s, box-shadow .12s",
                "border-radius": "var(--radius-md)", "font-size": "13px", color: "var(--fg-default)",
              }}
            />

            {/* Actions */}
            <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "8px" }}>
              <Button variant="ghost" onClick={close} disabled={busy() !== null}>Cancel</Button>
              <div style={{ display: "flex", gap: "8px" }}>
                <Button variant="outline" onClick={pushWithoutSquashing} disabled={busy() !== null}>
                  <Show when={busy() === "plain"}><Spinner size={12} /></Show>
                  Push all {s().commits.length}
                </Button>
                <Button variant="solid" onClick={squashAndPush} disabled={busy() !== null || !name().trim()}>
                  <Show when={busy() === "squash"}><Spinner size={12} /></Show>
                  Squash & push
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};
