import { Component, createSignal, Show } from "solid-js";
import { store } from "../lib/store";
import { ptyInput, autoCommit } from "../lib/ipc";
import { agentColor, agentLetter } from "../App";

const PromptComposer: Component = () => {
  const [value, setValue] = createSignal("");
  const [sending, setSending] = createSignal(false);

  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const activeColor = () => activeTab() ? agentColor(activeTab()!.agentId) : "#8b949e";
  const placeholder = () => {
    const tab = activeTab();
    if (tab) return `Prompt ${tab.label}`;
    if (store.currentProject) return "No agent running - enter commit message";
    return "Open a project or start an agent";
  };

  async function send() {
    const text = value().trim();
    if (!text || sending()) return;

    const tab = activeTab();
    setSending(true);

    try {
      if (tab) {
        // Send to the active PTY session
        await ptyInput(tab.sessionId, text + "\r");
      } else if (store.currentProject) {
        // No agent running — commit directly
        await autoCommit(store.currentProject.path, text);
      }
      setValue("");
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={{
      flex: "0 0 auto",
      background: "#0f1116",
      "border-top": "1px solid #1d2028",
      padding: "13px 16px",
    }}>
      <div style={{
        display: "flex", "align-items": "center", gap: "12px",
        background: "#14161d",
        border: `1px solid ${activeColor()}55`,
        "border-radius": "11px",
        padding: "11px 14px",
        "box-shadow": `0 0 0 3px ${activeColor()}14`,
      }}>
        {/* Agent badge */}
        <span style={{
          width: "20px", height: "20px", "border-radius": "6px",
          background: activeColor(), color: "#0d1117",
          "font-family": "'JetBrains Mono', monospace",
          "font-weight": "700", "font-size": "11px",
          display: "flex", "align-items": "center", "justify-content": "center",
          flex: "0 0 auto",
        }}>
          <Show when={activeTab()} fallback={
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0d1117" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          }>
            {agentLetter(activeTab()!.agentId)}
          </Show>
        </span>

        {/* Input */}
        <textarea
          rows={1}
          placeholder={placeholder()}
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          style={{
            flex: "1",
            "font-family": "'JetBrains Mono', monospace",
            "font-size": "13px",
            color: value() ? "var(--fg-default)" : "var(--fg-subtle)",
            background: "none",
            border: "none",
            outline: "none",
            resize: "none",
            "line-height": "1.5",
            "max-height": "120px",
            overflow: "auto",
          }}
        />

        {/* ⏎ commit hint */}
        <Show when={!activeTab()}>
          <span style={{
            "font-family": "'JetBrains Mono', monospace",
            "font-size": "10.5px", color: "var(--fg-subtle)",
            border: "1px solid #262a35", "border-radius": "6px",
            padding: "3px 8px", flex: "0 0 auto",
          }}>
            ⏎ commit
          </span>
        </Show>

        {/* Send button */}
        <button
          onclick={send}
          disabled={sending() || !value().trim()}
          style={{
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "34px", height: "34px",
            "border-radius": "9px",
            background: value().trim() ? activeColor() : "#1a1d25",
            flex: "0 0 auto",
            transition: "background 0.15s",
            cursor: value().trim() ? "pointer" : "default",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke={value().trim() ? "#0d1117" : "#6e7681"}
            stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 11l5-5 5 5M12 6v13" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default PromptComposer;
