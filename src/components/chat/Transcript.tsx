import { Component, For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { activeView, chat, pendingInputCount, dropQueued, isRunning, sendQueuedNow } from "../../lib/chat";
import { Icon } from "../shell/Icon";
import { AssistantBubble, Divider, UserBubble } from "./MessageItem";

const STICK_THRESHOLD = 80;
/** Long sessions render only their most recent messages until asked for more. */
const PAGE = 150;

interface ScrollMemo { top: number; stuck: boolean }
/** Scroll position per session, so switching away and back lands where you were. */
const scrollMemory = new Map<string, ScrollMemo>();

/** Scrolling message list. Follows new output while the user is at the bottom;
 *  scrolling up pauses it and shows a "jump to latest" button. */
const Transcript: Component = () => {
  let scroller: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  const [stuck, setStuck] = createSignal(true);
  const [limit, setLimit] = createSignal(PAGE);

  const toBottom = (smooth = false) => {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  const onScroll = () => {
    if (!scroller) return;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD;
    setStuck(atBottom);
    if (chat.activeId) scrollMemory.set(chat.activeId, { top: scroller.scrollTop, stuck: atBottom });
  };

  onMount(() => {
    if (!content) return;
    // Streaming text, tool rows and expansions all change height; follow them.
    const ro = new ResizeObserver(() => {
      if (stuck()) toBottom();
    });
    ro.observe(content);
    onCleanup(() => ro.disconnect());
  });

  // Opening another session restores where you left it (bottom by default).
  createEffect(on(() => chat.activeId, (id) => {
    setLimit(PAGE);
    const memo = id ? scrollMemory.get(id) : undefined;
    setStuck(memo ? memo.stuck : true);
    requestAnimationFrame(() => {
      if (memo && !memo.stuck && scroller) scroller.scrollTop = memo.top;
      else toBottom();
    });
  }));

  const all = () => activeView()?.messages ?? [];
  const hidden = () => Math.max(0, all().length - limit());
  const messages = createMemo(() => (hidden() > 0 ? all().slice(hidden()) : all()));
  const queue = () => (chat.activeId ? chat.queued[chat.activeId] ?? [] : []);
  const running = () => (chat.activeId ? isRunning(chat.activeId) : false);

  // Announced to screen readers; the transcript itself is not a live region
  // because streaming text would be read out token by token.
  const [announcement, setAnnouncement] = createSignal("");
  createEffect(on(running, (now, was) => {
    if (was === undefined) return;
    setAnnouncement(now ? "The agent is working" : "The agent finished");
  }));

  createEffect(() => { if (chat.activeId && pendingInputCount(chat.activeId)) setAnnouncement("The agent needs your input"); });

  const loadEarlier = () => {
    const before = scroller?.scrollHeight ?? 0;
    setLimit((n) => n + PAGE);
    // Keep the viewport anchored on what the user was reading.
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
    });
  };

  return (
    <div class="transcript-wrap">
      <div class="transcript" ref={scroller} onScroll={onScroll} role="log" aria-label="Conversation" aria-live="off">
        <div class="transcript-inner" ref={content}>
          <Show when={hidden() > 0}>
            <button type="button" class="load-earlier" onClick={loadEarlier}>
              Load earlier messages ({hidden()})
            </button>
          </Show>
          <For each={messages()}>
            {(message, i) => (
              <Switch>
                <Match when={message.role === "user" && message}>
                  {(m) => <UserBubble message={m() as Extract<typeof message, { role: "user" }>} />}
                </Match>
                <Match when={message.role === "divider" && message}>
                  {(m) => <Divider message={m() as Extract<typeof message, { role: "divider" }>} />}
                </Match>
                <Match when={message.role === "assistant" && message}>
                  {(m) => (
                    <AssistantBubble
                      sessionId={chat.activeId ?? ""}
                      message={m() as Extract<typeof message, { role: "assistant" }>}
                      isLast={i() === messages().length - 1}
                    />
                  )}
                </Match>
              </Switch>
            )}
          </For>
          <Show when={queue().length > 0}>
            <div class="queued">
              <For each={queue()}>
                {(text, i) => (
                  <div class="queued-item">
                    <span class="queued-label">Queued</span>
                    <span class="queued-text">
                      {text.text || `${text.attachments.length} attachment${text.attachments.length === 1 ? "" : "s"}`}
                      <Show when={text.text && text.attachments.length > 0}> · {text.attachments.length} attached</Show>
                    </span>
                    <Show when={!running() && chat.activeId}>
                      <button
                        type="button"
                        class="queued-send"
                        onClick={() => void sendQueuedNow(chat.activeId!, i())}
                      >
                        Send now
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="icon-btn"
                      title="Remove from queue"
                      aria-label="Remove from queue"
                      onClick={() => chat.activeId && dropQueued(chat.activeId, i())}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
      <div class="sr-only" role="status" aria-live="polite">{announcement()}</div>
      <Show when={!stuck()}>
        <button type="button" class="jump-latest" onClick={() => { setStuck(true); toBottom(true); }}>
          <Icon name="arrowUp" size={14} style={{ transform: "rotate(180deg)" }} />
          Latest
        </button>
      </Show>
    </div>
  );
};

export default Transcript;
