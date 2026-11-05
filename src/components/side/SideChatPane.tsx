import { Component, For, Show, createSignal } from "solid-js";
import { chat, deleteSession, selectSession, sendPromptTo, setChat, setSideQuestion, sideQuestion } from "../../lib/chat";
import { chatUpdateSession } from "../../lib/ipc";
import { setStore } from "../../lib/store";
import { lastAssistant, toBlockquote } from "../../lib/transcript";
import { Spinner, toast } from "../ui";
import { Icon } from "../shell/Icon";
import Markdown from "../chat/Markdown";

/** Right-panel side chats. `/btw` opens this tab with a hidden read-only fork; older
 *  side chats stay listed so their answer can be reopened without changing the parent. */
const SideChatPane: Component = () => {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const sideChats = () => chat.sessions
    .filter((session) => session.hidden && session.parent_id)
    .sort((a, b) => b.updated_at - a.updated_at);
  const currentId = () => sideQuestion()?.id ?? selectedId() ?? sideChats()[0]?.id ?? null;
  const current = () => chat.sessions.find((session) => session.id === currentId());
  const view = () => { const id = currentId(); return id ? chat.views[id] : undefined; };
  const answer = () => { const v = view(); return v ? lastAssistant(v) : undefined; };
  const working = () => !answer() || answer()!.status === "running";
  const answerText = () => answer()?.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n\n") ?? "";
  const parent = () => {
    const parentId = current()?.parent_id;
    return parentId ? chat.sessions.find((session) => session.id === parentId) : undefined;
  };
  const [followUp, setFollowUp] = createSignal("");
  const [sending, setSending] = createSignal(false);

  const askFollowUp = async (event: Event) => {
    event.preventDefault();
    const side = current();
    const message = followUp().trim();
    if (!side || !message || working() || sending()) return;
    setSending(true);
    try {
      const sent = await sendPromptTo(side.id, message, { agentId: side.agent_id, mode: "ask", yolo: false });
      if (sent) setFollowUp("");
      else toast("The follow-up could not be sent.", "error");
    } finally {
      setSending(false);
    }
  };

  const discard = () => {
    const side = current();
    if (!side) return;
    if (sideQuestion()?.id === side.id) setSideQuestion(null);
    setSelectedId(null);
    void deleteSession(side.id);
  };

  const bringBack = () => {
    const side = current();
    if (!side) return;
    setStore("pendingPromptSeed", { text: toBlockquote(`Side question: ${sideQuestion()?.question ?? side.title}\n\n${answerText()}`) });
    discard();
  };

  const keep = async () => {
    const side = current();
    if (!side) return;
    const meta = await chatUpdateSession(side.id, { hidden: false }).catch(() => undefined);
    if (!meta) return;
    setChat("sessions", (sessions) => sessions.id === side.id, meta);
    if (sideQuestion()?.id === side.id) setSideQuestion(null);
    setSelectedId(null);
    await selectSession(side.id);
  };

  return (
    <div class="side-chat-pane">
      <Show when={sideChats().length > 0} fallback={
        <div class="pane-empty side-chat-empty">
          <Icon name="help" size={28} />
          <p>No side chats yet.</p>
          <p class="pane-empty-sub">Ask <code>/btw &lt;question&gt;</code> in a conversation to investigate without changing it.</p>
        </div>
      }>
        <div class="side-chat-switcher" role="tablist" aria-label="Side chats">
          <For each={sideChats()}>
            {(side) => (
              <button type="button" role="tab" aria-selected={side.id === currentId()} classList={{ "side-chat-switch-on": side.id === currentId() }}
                title={side.title || "Side chat"}
                onClick={() => { setSelectedId(side.id); setSideQuestion(null); }}>
                <Icon name="help" size={11} /> {side.title || "Side chat"}
              </button>
            )}
          </For>
        </div>
        <Show when={current()} fallback={<div class="pane-empty">Select a side chat.</div>}>
          {(side) => (
            <>
              <div class="side-chat-head">
                <div class="side-chat-question">
                  <span>Side question</span>
                  <strong>{sideQuestion()?.question ?? side().title ?? "Side chat"}</strong>
                  <Show when={parent()}>{(thread) => <small>About {thread().title || "this conversation"}</small>}</Show>
                </div>
                <span class="side-chat-badge">{working() ? "Working" : "Read-only"}</span>
              </div>
              <div class="side-chat-body">
                <Show when={answerText()} fallback={<span class="side-chat-thinking"><Spinner size={13} /> Thinking…</span>}>
                  <Markdown text={answerText()} />
                </Show>
                <Show when={working() && answerText()}><span class="side-chat-thinking"><Spinner size={12} /> Working…</span></Show>
              </div>
              <form class="side-chat-composer" onSubmit={askFollowUp}>
                <input class="ui-field" aria-label="Ask a follow-up side question" placeholder="Ask a follow-up…" value={followUp()} disabled={working() || sending()}
                  onInput={(event) => setFollowUp(event.currentTarget.value)} />
                <button type="submit" class="ui-btn ui-btn-outline" disabled={working() || sending() || !followUp().trim()}>
                  <Icon name="message" size={12} /> Ask
                </button>
              </form>
              <div class="side-chat-actions">
                <button type="button" class="ui-btn ui-btn-ghost" onClick={discard}>Discard</button>
                <button type="button" class="ui-btn ui-btn-outline" disabled={working()} onClick={() => void keep()}>Open as session</button>
                <button type="button" class="ui-btn ui-btn-solid" disabled={working() || !answerText()} onClick={bringBack}>Bring back</button>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
};

export default SideChatPane;
