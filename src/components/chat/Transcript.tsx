import { Component, For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { activeView, chat, pendingInputCount, dropQueued, isRunning, sendQueuedNow, onLivePresentation, onClearMotion } from "../../lib/chat";
import { resolvedMotion } from "../../lib/layout";
import { openConversationFile } from "../../lib/attachments";
import { openUrl } from "@tauri-apps/plugin-opener";
import { animateElement, reveal, cancelMotion, consumePromptLaunch, useListMotion, toast } from "../ui";
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
  const [fileModHeld, setFileModHeld] = createSignal(false);
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const hasFileMod = (event: MouseEvent) => isMac ? event.metaKey : event.ctrlKey;
  const [limit, setLimit] = createSignal(PAGE);
  const queueKeys = new WeakMap<object, string>();
  let queueKey = 0;
  const keyOf = (item: object) => { if (!queueKeys.has(item)) queueKeys.set(item, `q-${++queueKey}`); return queueKeys.get(item)!; };
  useListMotion(() => content, () => (chat.activeId ? chat.queued[chat.activeId] ?? [] : []).map(keyOf).join(), ".queued-item");
  const seen = new Set<string>();
  let disposed = false;
  onMount(() => {
    const syncModifier = (event: KeyboardEvent) => setFileModHeld(isMac ? event.metaKey : event.ctrlKey);
    const clearModifier = () => setFileModHeld(false);
    window.addEventListener("keydown", syncModifier);
    window.addEventListener("keyup", syncModifier);
    window.addEventListener("blur", clearModifier);
    onCleanup(() => {
      window.removeEventListener("keydown", syncModifier);
      window.removeEventListener("keyup", syncModifier);
      window.removeEventListener("blur", clearModifier);
    });
    const off = onLivePresentation((sessionId, hints) => {
      queueMicrotask(() => {
        if (disposed || document.hidden || chat.activeId !== sessionId || !content) return;
        if (stuck()) toBottom(false);
        const targets = new Set<HTMLElement>();
        for (const hint of hints) {
          const key = `${hint.kind}:${hint.messageId}:${hint.itemId ?? ""}:${hint.status ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key); if (seen.size > 256) seen.delete(seen.values().next().value!);
          const message = content.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(hint.messageId)}"]`);
          if (!message) continue;
          const item = hint.itemId ? message.querySelector<HTMLElement>(`[data-motion-id="${CSS.escape(hint.itemId)}"]`) : undefined;
          if (hint.kind === "user") {
            const bubble = message.querySelector<HTMLElement>(".msg-user-stack") ?? message;
            if (!consumePromptLaunch(bubble)) targets.add(message);
            continue;
          }
          if (hint.kind === "flip") {
            const marker = message.querySelector<HTMLElement>(".handoff-marker");
            if (marker) void animateElement(marker, [{ opacity: 0, transform: "translateX(0)" }, { opacity: 1, offset: .12 }, { opacity: 0, transform: `translateX(${Math.max(0, marker.parentElement!.clientWidth - 8)}px)` }], 420);
            continue;
          }
          const target = hint.kind === "start" ? message.querySelector<HTMLElement>(".msg-assistant-head") : hint.kind === "text" ? message.querySelector<HTMLElement>(".md") : hint.kind === "tool-result" ? item?.querySelector<HTMLElement>(".tool-row-state") : hint.kind === "finish" ? message.querySelector<HTMLElement>(hint.status === "done" ? ".msg-done" : ".msg-error, .msg-note") : item ?? (hint.kind === "tool" ? message.querySelector<HTMLElement>(".tool-group-head") : message);
          if (target) targets.add(target);
          if (hint.kind === "finish" && hint.status === "done") {
            const changes = message.querySelector<HTMLElement>(".turn-changes");
            if (changes) targets.add(changes);
          }
        }
        targets.forEach((target) => void reveal(target, 180));
      });
    });
    // /clear: the conversation lifts away and softens, then the empty session settles in.
    const offClear = onClearMotion(async (swap) => {
      await animateElement(content, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px) scale(.992)" }], 200);
      swap();
      seen.clear();
      if (scroller) scroller.scrollTop = 0;
      setStuck(true);
      await animateElement(content, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], 260);
    });
    onCleanup(() => { offClear(); disposed = true; off(); content?.querySelectorAll<HTMLElement>("[data-message-id], [data-motion-id], .msg-user-stack, .md, .msg-assistant-head, .handoff-marker, .msg-done, .turn-changes").forEach(cancelMotion); seen.clear(); });
  });

  const toBottom = (smooth = false) => {
    if (!scroller) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && resolvedMotion() === "full" ? "smooth" : "auto" });
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
    seen.clear();
    if (content) void animateElement(content, [{ opacity: .65 }, { opacity: 1 }], 120);
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

  const onLinkClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-file-path]");
    if (link && scroller?.contains(link)) {
      event.preventDefault();
      if (!hasFileMod(event) && event.detail !== 0) return;
      const path = link.dataset.filePath;
      if (!path) return;
      void (async () => {
        try {
          await openConversationFile(path);
        } catch (error) {
          toast(`Couldn't open ${path}: ${String(error)}`, "error");
        }
      })();
      return;
    }
    const webLink = event.target.closest<HTMLAnchorElement>("a[data-md-link]");
    if (!webLink || !scroller?.contains(webLink)) return;
    event.preventDefault();
    void openUrl(webLink.href).catch((error) => toast(`Couldn't open link: ${String(error)}`, "error"));
  };

  return (
    <div class="transcript-wrap">
      <div class="transcript" classList={{ "file-mod-held": fileModHeld() }} ref={scroller} onScroll={onScroll} onClick={onLinkClick} onMouseMove={(event) => setFileModHeld(hasFileMod(event))} role="log" aria-label="Conversation" aria-live="off">
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
                  <div class="queued-item" data-motion-key={keyOf(text)}>
                    <span class="queued-label">Queued</span>
                    <span class="queued-text">
                      {text.text || `${text.attachments.length} attachment${text.attachments.length === 1 ? "" : "s"}`}
                      <Show when={text.text && text.attachments.length > 0}> · {text.attachments.length} attached</Show>
                    </span>
                    <Show when={chat.activeId}>
                      <button
                        type="button"
                        class="queued-send"
                        title={running() ? `Interrupt and send now (${isMac ? "⌘" : "Ctrl+"}Enter)` : "Send now"}
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
