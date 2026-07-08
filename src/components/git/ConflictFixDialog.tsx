import { Component, For, Show, createSignal } from "solid-js";
import { store, addTab, rankContinueCandidates } from "../../lib/store";
import { spawnAgent, ptyInput, onPtyOutput, type AgentInfo } from "../../lib/ipc";
import { markSessionTaskStarted } from "../../lib/orchestrator";
import { AgentLogo } from "../../lib/agentMeta";
import { Button, Menu, MenuItem, Spinner, toast } from "../ui";

interface ConflictState {
  files: string[];
}

const [state, setState] = createSignal<ConflictState | null>(null);

/** Show the "fix with an AI agent, or leave it" dialog for a set of
 *  conflicted file paths (e.g. after a pull that couldn't fast-forward and
 *  fell back to a real merge). */
export function openConflictDialog(files: string[]) {
  setState({ files });
}

function buildConflictPrompt(files: string[]): string {
  const list = files.map((f) => `- ${f}`).join("\n");
  return `Pulling from the remote created a merge conflict in ${files.length} file${files.length === 1 ? "" : "s"}:\n${list}\n\nPlease resolve the conflict markers (<<<<<<<, =======, >>>>>>>) in these files, keeping the intent of both sides where they don't overlap, then let me know when it's done so I can review.`;
}

export const ConflictFixDialogHost: Component = () => {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [selectedAgentId, setSelectedAgentId] = createSignal<string | null>(null);
  const [launching, setLaunching] = createSignal(false);
  let pickerAnchor: HTMLButtonElement | undefined;

  const candidates = (): AgentInfo[] => {
    const projectPath = store.currentProject?.path ?? "";
    return rankContinueCandidates(projectPath, "", store.agents, false)
      .filter((agent) => !store.yoloMode || agent.yolo_supported);
  };

  const selectedAgent = (): AgentInfo | undefined => {
    const id = selectedAgentId();
    const list = candidates();
    return (id ? list.find((a) => a.id === id) : undefined) ?? list[0];
  };

  function close() {
    setState(null);
    setSelectedAgentId(null);
    setPickerOpen(false);
  }

  async function fixIt() {
    const s = state();
    const project = store.currentProject;
    const agent = selectedAgent();
    if (!s || !project || !agent) return;
    setLaunching(true);
    try {
      const sessionId = await spawnAgent(agent.id, project.path, store.yoloMode);
      addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });

      // Type the prompt in once the CLI has produced its first output (i.e.
      // it's booted and ready for input), with a timeout fallback in case it
      // stays silent.
      const prompt = buildConflictPrompt(s.files);
      let sent = false;
      const send = () => {
        if (sent) return;
        sent = true;
        markSessionTaskStarted(sessionId);
        void ptyInput(sessionId, prompt + "\r");
      };
      const unlisten = await onPtyOutput(sessionId, send);
      setTimeout(() => {
        send();
        unlisten();
      }, 4000);

      toast(`Opened ${agent.name} to fix the conflict`, "success");
      close();
    } catch (e) {
      toast(`Failed to launch ${agent.name}: ${String(e)}`, "error");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <Show when={state()}>
      {(s) => (
        <div
          class="overlay-backdrop-in"
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
            class="overlay-pop-in"
            onclick={(e) => e.stopPropagation()}
            style={{
              width: "380px",
              background: "var(--surface-3)",
              border: "1px solid var(--border-default)",
              "border-radius": "var(--radius-xl)",
              "box-shadow": "var(--shadow-menu)",
              padding: "18px",
            }}
          >
            <div style={{ "font-size": "13.5px", color: "var(--fg-default)", "font-weight": "600", "margin-bottom": "6px" }}>
              Merge conflict after pulling
            </div>
            <div style={{ "font-size": "12px", color: "var(--fg-muted)", "line-height": "1.5", "margin-bottom": "10px" }}>
              {s().files.length} file{s().files.length === 1 ? "" : "s"} need resolution. Nothing else changed —
              the merge is left in place so you (or an agent) can fix it.
            </div>
            <div style={{
              "max-height": "120px", overflow: "auto",
              "font-family": "var(--font-mono)", "font-size": "11px", color: "var(--fg-subtle)",
              background: "var(--surface-1)", "border-radius": "var(--radius-md)",
              padding: "8px 10px", "margin-bottom": "14px",
            }}>
              <For each={s().files}>{(f) => <div>{f}</div>}</For>
            </div>

            <button
              ref={pickerAnchor}
              onclick={() => setPickerOpen((o) => !o)}
              disabled={candidates().length === 0}
              style={{
                display: "flex", "align-items": "center", gap: "8px", width: "100%",
                padding: "7px 10px", "margin-bottom": "14px",
                background: "var(--surface-4)", border: "1px solid var(--border-default)",
                "border-radius": "var(--radius-md)", "font-size": "12.5px", color: "var(--fg-default)",
                cursor: candidates().length === 0 ? "default" : "pointer",
              }}
            >
              <Show
                when={selectedAgent()}
                fallback={<span style={{ color: "var(--fg-subtle)" }}>No installed agents</span>}
              >
                {(agent) => (
                  <>
                    <AgentLogo agentId={agent().id} icon={agent().icon} name={agent().name} size={16} radius={4} />
                    <span style={{ flex: "1", "text-align": "left" }}>Fix with {agent().name}</span>
                  </>
                )}
              </Show>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            <Menu open={pickerOpen()} onClose={() => setPickerOpen(false)} anchorRef={pickerAnchor} width={340}>
              <For each={candidates()}>
                {(agent) => (
                  <MenuItem onSelect={() => { setSelectedAgentId(agent.id); setPickerOpen(false); }}>
                    <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} size={16} radius={4} />
                    <span style={{ flex: "1", "font-size": "12.5px" }}>{agent.name}</span>
                  </MenuItem>
                )}
              </For>
            </Menu>

            <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
              <Button variant="ghost" onClick={close}>Keep conflicted</Button>
              <Button variant="solid" onClick={fixIt} disabled={launching() || !selectedAgent()}>
                <Show when={launching()}><Spinner size={12} /></Show>
                Fix it
              </Button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};
