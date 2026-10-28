import { Component, For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { activeSession, agentTuning, chat } from "../../lib/chat";
import { hydrateAgentModels } from "../../lib/agentMeta";
import { layout } from "../../lib/layout";
import {
  effectiveChoice, explain, explainChoice, explainIsStale, ollamaChoiceMissing, explanationFor, headlessAgents, ollamaModels,
  refreshOllamaModels, resolveProvider, setExplainChoice, type ExplainChoice,
} from "../../lib/explain";
import { Icon } from "../shell/Icon";
import Markdown from "../chat/Markdown";
import { Spinner } from "../ui";
import { writeClipboardText } from "../../lib/native";

const encode = (choice: ExplainChoice) => JSON.stringify(choice);

/** Model picker shared by the Explain tab and Settings. */
export const ExplainProviderSelect: Component = () => {
  onMount(() => { void refreshOllamaModels(); void hydrateAgentModels(); });
  const change = (value: string) => { try { setExplainChoice(JSON.parse(value) as ExplainChoice); } catch { /* ignore */ } };
  return (
    <select class="explain-select" value={encode(effectiveChoice())} onChange={(e) => change(e.currentTarget.value)} title="Model that writes the explanation" aria-label="Explanation model">
      <option value={encode({ kind: "auto" })}>Auto (cheapest model)</option>
      <For each={headlessAgents()}>
        {(agent) => (
          <optgroup label={agent.name}>
            <option value={encode({ kind: "agent", agent_id: agent.id, model: null })}>{agent.name} · default</option>
            <For each={agentTuning(agent.id)?.models ?? []}>
              {(m) => <option value={encode({ kind: "agent", agent_id: agent.id, model: m.id })}>{agent.name} · {m.label}</option>}
            </For>
          </optgroup>
        )}
      </For>
      <Show when={ollamaChoiceMissing()}>
        <option value={encode(explainChoice())} disabled>{(explainChoice() as { model: string }).model} (not installed)</option>
      </Show>
      <Show when={ollamaModels().length > 0}>
        <optgroup label="Ollama (local)">
          <For each={ollamaModels()}>{(m) => <option value={encode({ kind: "ollama", model: m })}>{m}</option>}</For>
        </optgroup>
      </Show>
    </select>
  );
};

/** Plain-language explanation of the active session and of any open agent question. */
const ExplainView: Component = () => {
  const session = activeSession;
  const visible = () => layout.sideOpen && layout.sideTab === "explain";
  const current = () => { const s = session(); return s ? explanationFor(s.id) : undefined; };
  const fallback = () => { const s = session(); return s ? resolveProvider(s.agent_id).fallback : false; };

  // Generate only while visible. The delay merges bursts (turn end + new request).
  createEffect(() => {
    const s = session();
    if (!visible() || !s) return;
    void chat.views[s.id]?.messages.length;
    void chat.views[s.id]?.running;
    void chat.views[s.id]?.runtime?.pending.length;
    // Re-check when a request ends, so changes made meanwhile are not missed.
    void explanationFor(s.id)?.loading;
    void effectiveChoice();
    const timer = window.setTimeout(() => { if (explainIsStale(s.id)) void explain(s.id); }, 1500);
    onCleanup(() => window.clearTimeout(timer));
  });

  const [, tick] = createSignal(0);
  const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
  onCleanup(() => window.clearInterval(timer));
  const ago = () => {
    const at = current()?.at;
    if (!at) return "";
    const minutes = Math.floor((Date.now() - at) / 60_000);
    return minutes < 1 ? "just now" : `${minutes} min ago`;
  };

  return (
    <div class="explain-view">
      <div class="explain-head">
        <ExplainProviderSelect />
        <button class="icon-btn" disabled={!current()?.text} onClick={() => void writeClipboardText(current()?.text ?? "", "explanation")} title="Copy explanation" aria-label="Copy explanation">
          <Icon name="clipboard" size={15} />
        </button>
        <button class="icon-btn" disabled={!session() || current()?.loading} onClick={() => session() && void explain(session()!.id, true)} title="Explain again" aria-label="Explain again">
          <Show when={current()?.loading} fallback={<Icon name="refresh" size={15} />}><Spinner size={13} /></Show>
        </button>
      </div>
      <div class="explain-body" aria-live="polite" aria-busy={current()?.loading ? "true" : "false"}>
        <Show when={session()} fallback={<p class="empty-hint">Open a session to see what happens in it.</p>}>
          <Show when={fallback()}>
            <p class="explain-note">This agent cannot run a short prompt. Another installed agent writes the explanation.</p>
          </Show>
          <Show when={current()?.error}>{(error) => <p class="explain-error" role="alert">{error()}</p>}</Show>
          <Show when={current()?.text} fallback={<Show when={!current()?.error}><p class="empty-hint">{current()?.loading ? "Writing the explanation…" : "No explanation yet."}</p></Show>}>
            {(text) => <div classList={{ "explain-stale": current()?.loading }}><Markdown text={text()} /></div>}
          </Show>
          <Show when={current()?.source}>
            <p class="explain-meta">{current()!.source} · {ago()}</p>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default ExplainView;
