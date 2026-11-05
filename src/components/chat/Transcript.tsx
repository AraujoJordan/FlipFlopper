import { Component, For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { activeView, chat, pendingInputCount, dropQueued, isRunning, sendQueuedNow, onLivePresentation, onClearMotion } from "../../lib/chat";
import { resolvedMotion } from "../../lib/layout";
import { setPendingPromptSeed } from "../../lib/store";
import { citeInComposer, firstUnreadId } from "../../lib/transcript";
import { sessionGoal } from "../../lib/goals";
import { addAttachments, openConversationFile } from "../../lib/attachments";
import { openUrl } from "@tauri-apps/plugin-opener";
import { animateElement, reveal, cancelMotion, consumePromptLaunch, useListMotion, toast } from "../ui";
import { Icon } from "../shell/Icon";
import { AssistantBubble, Divider, UserBubble } from "./MessageItem";
import FindBar from "./FindBar";
import { openFileInViewer } from "../../lib/fileViewer";
import TimelineMinimap from "./TimelineMinimap";

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
  // Quote reply: a floating button over text selected inside one assistant message.
  const [quote, setQuote] = createSignal<{ text: string; left: number; top: number } | null>(null);
  const [quoteComment, setQuoteComment] = createSignal("");
  const evaluateSelection = () => {
    const selection = window.getSelection();
    // Stepping through find results may select text; that is not a request to quote it.
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !scroller || document.activeElement?.closest(".find-bar")) return hideQuote();
    // Typing a comment in the citation popover collapses the selection; keep the popover.
    if (document.activeElement?.closest(".quote-pop")) return;
    const bubble = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest(".msg-assistant") ?? null;
    const start = bubble(selection.anchorNode);
    const text = selection.toString().trim();
    if (!start || start !== bubble(selection.focusNode) || !scroller.contains(start) || !text) return setQuote(null);
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    // A small card under the selection, clamped to the viewport.
    setQuote({
      text,
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - 146, window.innerWidth - 308)),
      top: Math.min(Math.max(8, rect.bottom + 8), Math.max(8, window.innerHeight - 196)),
    });
  };
  const afterPointerOrKey = () => setTimeout(evaluateSelection, 0);
  const hideQuote = () => { setQuote(null); setQuoteComment(""); };
  const hideCollapsedQuote = () => {
    if (document.activeElement?.closest(".quote-pop")) return;
    if (window.getSelection()?.isCollapsed) hideQuote();
  };
  onMount(() => {
    document.addEventListener("mouseup", afterPointerOrKey);
    document.addEventListener("keyup", afterPointerOrKey);
    document.addEventListener("selectionchange", hideCollapsedQuote);
    const hide = () => setQuote(null);
    scroller?.addEventListener("scroll", hide, { passive: true });

    // The command palette's message search lands on the matching message.
    const findRevealTarget = (role: string, ts: number) => {
      if (!content) return undefined;
      const nodes = [...content.querySelectorAll<HTMLElement>(role === "user" ? ".msg-user[data-ts]" : ".msg-assistant[data-ts]")]
        .map((element) => ({ element, ts: Number(element.dataset.ts) }))
        .filter((entry) => Number.isFinite(entry.ts));
      if (role === "user") return (nodes.find((entry) => entry.ts === ts) ?? nodes.find((entry) => entry.ts >= ts))?.element;
      return (nodes.filter((entry) => entry.ts <= ts).pop() ?? nodes[0])?.element;
    };
    const revealHit = (role: string, ts: number) => {
      const target = findRevealTarget(role, ts);
      if (!target) return false;
      setStuck(false);
      target.scrollIntoView({ block: "center" });
      void animateElement(target, [
        { backgroundColor: "rgba(var(--accent-rgb), .18)" },
        { backgroundColor: "rgba(var(--accent-rgb), .05)", offset: .35 },
        { backgroundColor: "transparent" },
      ], 1500);
      return true;
    };
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; ts?: number; role?: string }>).detail;
      if (!detail || detail.sessionId !== chat.activeId || !Number.isFinite(detail.ts)) return;
      const role = detail.role === "user" ? "user" : "assistant";
      if (revealHit(role, detail.ts!)) return;
      // The hit may be in an older page; show everything, then try once more.
      if (hidden() > 0) {
        setLimit(Number.MAX_SAFE_INTEGER);
        requestAnimationFrame(() => requestAnimationFrame(() => revealHit(role, detail.ts!)));
      }
    };
    window.addEventListener("flipflopper:reveal-message", onReveal);
    onCleanup(() => {
      document.removeEventListener("mouseup", afterPointerOrKey);
      document.removeEventListener("keyup", afterPointerOrKey);
      document.removeEventListener("selectionchange", hideCollapsedQuote);
      scroller?.removeEventListener("scroll", hide);
      window.removeEventListener("flipflopper:reveal-message", onReveal);
    });
  });
  const insertQuote = () => {
    const q = quote();
    if (!q) return;
    setPendingPromptSeed({ text: citeInComposer(q.text, quoteComment()) });
    window.getSelection()?.removeAllRanges();
    hideQuote();
  };
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
  const goal = createMemo(() => {
    const id = chat.activeId;
    const value = id ? sessionGoal(id) : "";
    return value || null;
  });
  const unreadId = createMemo(() => (chat.activeId ? firstUnreadId(messages(), chat.unreadFrom[chat.activeId]) : null));
  /** Scroll a prompt into view, first rendering the older messages when it is not on screen yet. */
  const jumpTo = (id: string) => {
    const find = () => content?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    const element = find();
    if (element) { setStuck(false); element.scrollIntoView({ block: "start" }); return; }
    setLimit(Number.MAX_SAFE_INTEGER);
    requestAnimationFrame(() => requestAnimationFrame(() => { setStuck(false); find()?.scrollIntoView({ block: "start" }); }));
  };
  /** Pull a queued message back into the composer (an unsent draft stays above it). */
  const editQueued = (index: number) => {
    const id = chat.activeId;
    const item = id ? chat.queued[id]?.[index] : undefined;
    if (!id || !item) return;
    dropQueued(id, index);
    addAttachments(item.attachments);
    if (item.text) setPendingPromptSeed({ text: item.text });
  };
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
      const path = link.dataset.filePath;
      if (!path) return;
      const line = Number(link.dataset.fileLine) || null;
      // A plain click previews the file in the Files tab; Cmd/Ctrl-click opens it in the editor or default app.
      if (!hasFileMod(event)) { void openFileInViewer(path, line); return; }
      void (async () => {
        try {
          await openConversationFile(path, line);
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
      <div class="transcript" data-focus-area="conversation" tabIndex={-1} classList={{ "file-mod-held": fileModHeld() }} ref={scroller} onScroll={onScroll} onClick={onLinkClick} onMouseMove={(event) => setFileModHeld(hasFileMod(event))} role="log" aria-label="Conversation" aria-live="off">
        <div class="transcript-inner" ref={content}>
          <Show when={hidden() > 0}>
            <button type="button" class="load-earlier" onClick={loadEarlier}>
              Load earlier messages ({hidden()})
            </button>
          </Show>
          <For each={messages()}>
            {(message, i) => (
              <>
              <Show when={message.id === unreadId()}>
                <div class="new-divider" role="separator" aria-label="New since you last looked"><span>New</span></div>
              </Show>
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
              </>
            )}
          </For>
          <Show when={chat.activeId && (running() || pendingInputCount(chat.activeId!) > 0 || queue().length > 0 || !!goal())}>
            <div class="thread-status-line" classList={{ "thread-status-working": running(), "thread-status-attention": pendingInputCount(chat.activeId!) > 0 }}>
              <span class="thread-status-dot" />
              <span>{running() ? "Working" : pendingInputCount(chat.activeId!) > 0 ? "Needs your input" : "Ready"}</span>
              <Show when={queue().length > 0}><span class="thread-status-chip">{queue().length} queued</span></Show>
              <Show when={goal()}>
                {(current) => <span class="thread-status-chip" title={current().text}>Goal · {current().status}</span>}
              </Show>
            </div>
          </Show>
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
                      title="Edit queued message"
                      aria-label="Edit queued message"
                      onClick={() => editQueued(i())}
                    >
                      <Icon name="pencil" size={13} />
                    </button>
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
      <TimelineMinimap scroller={() => scroller} messages={all} onJump={jumpTo} />
      <FindBar scroller={() => scroller} hasEarlier={() => hidden() > 0} showAll={() => setLimit(Number.MAX_SAFE_INTEGER)} />
      <div class="sr-only" role="status" aria-live="polite">{announcement()}</div>
      <Show when={quote()}>
        {(q) => (
          <div class="quote-pop" role="dialog" aria-label="Cite in composer" style={{ left: `${q().left}px`, top: `${q().top}px` }}>
            <div class="quote-pop-head"><Icon name="message" size={12} /> Cite in composer</div>
            <div class="quote-pop-preview" title={q().text}>{q().text.length > 160 ? `${q().text.slice(0, 160)}…` : q().text}</div>
            <textarea class="quote-pop-input" rows={2} aria-label="Comment about the quote" placeholder="Add a comment (optional)" value={quoteComment()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(event) => setQuoteComment(event.currentTarget.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") { event.preventDefault(); hideQuote(); }
                else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); insertQuote(); }
              }} />
            <div class="quote-pop-actions">
              <button type="button" class="ui-btn ui-btn-ghost" onMouseDown={(event) => event.preventDefault()} onClick={hideQuote}>Cancel</button>
              <button type="button" class="ui-btn ui-btn-solid" onMouseDown={(event) => event.preventDefault()} onClick={insertQuote}>Cite</button>
            </div>
          </div>
        )}
      </Show>
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
