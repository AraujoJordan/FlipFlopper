import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { store } from "../lib/store";
import {
  autoCommit,
  ensureWorkBranch,
  getFileTree,
  pickPromptFile,
  ptyInput,
} from "../lib/ipc";

// ── Per-agent slash-command registry ─────────────────────────────────────────

const AGENT_COMMANDS: Record<string, Array<{ cmd: string; desc: string }>> = {
  claude: [
    { cmd: "/help",        desc: "Show help & keybindings" },
    { cmd: "/compact",     desc: "Compact conversation history" },
    { cmd: "/clear",       desc: "Clear conversation" },
    { cmd: "/cost",        desc: "Show token usage & cost" },
    { cmd: "/config",      desc: "Open config editor" },
    { cmd: "/memory",      desc: "Edit memory files" },
    { cmd: "/review",      desc: "Review current diff" },
    { cmd: "/pr",          desc: "Open or create a pull request" },
    { cmd: "/init",        desc: "Scaffold CLAUDE.md" },
    { cmd: "/doctor",      desc: "Check environment health" },
    { cmd: "/bug",         desc: "Report a bug to Anthropic" },
    { cmd: "/vim",         desc: "Toggle vim keybindings" },
    { cmd: "/permissions", desc: "Manage tool permissions" },
    { cmd: "/logout",      desc: "Sign out" },
  ],
  codex: [
    { cmd: "/help",  desc: "Show help" },
    { cmd: "/clear", desc: "Clear conversation" },
    { cmd: "/add",   desc: "Add file to context" },
  ],
  agy: [
    { cmd: "/help",        desc: "Show help" },
    { cmd: "/clear",       desc: "Clear conversation" },
    { cmd: "/keybindings", desc: "Edit keybindings" },
  ],
  aider: [
    { cmd: "/help",      desc: "Show help" },
    { cmd: "/add",       desc: "Add file to context" },
    { cmd: "/drop",      desc: "Remove file from context" },
    { cmd: "/clear",     desc: "Clear conversation" },
    { cmd: "/commit",    desc: "Commit AI changes" },
    { cmd: "/diff",      desc: "Show diff of AI changes" },
    { cmd: "/undo",      desc: "Undo last commit" },
    { cmd: "/ask",       desc: "Ask without code changes" },
    { cmd: "/code",      desc: "Request code changes" },
    { cmd: "/architect", desc: "High-level planning mode" },
    { cmd: "/run",       desc: "Run a shell command" },
    { cmd: "/test",      desc: "Run tests" },
    { cmd: "/exit",      desc: "Exit aider" },
  ],
  amp: [
    { cmd: "/help",  desc: "Show help" },
    { cmd: "/clear", desc: "Clear conversation" },
    { cmd: "/tools", desc: "List available tools" },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function markdownHighlight(escaped: string): string {
  return (
    escaped
      .replace(/(```[\s\S]*?```)/g, '<span class="md-fence">$1</span>')
      .replace(/(`[^`\n]+`)/g, '<span class="md-code">$1</span>')
      .replace(/(\*\*)([^*\n]+)(\*\*)/g, '<span class="md-bold">$1$2$3</span>')
      .replace(/(?<!\*)(\*)([^*\n]+)(\*)(?!\*)/g, '<span class="md-em">$1$2$3</span>')
      .replace(/(^#{1,6} .+$)/gm, '<span class="md-heading">$1</span>')
      .replace(/(^&gt; .+$)/gm, '<span class="md-quote">$1</span>')
      .replace(/(@[\w./:-]+)/g, '<span class="md-ref">$1</span>')
      .replace(/(^[-*] )/gm, '<span class="md-bullet">$1</span>')
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AcItem {
  label: string;
  desc: string;
  isDir: boolean;
}

interface AcState {
  kind: "file" | "command";
  items: AcItem[];
  index: number;
  triggerPos: number; // index in full text where the @ or / starts
}

// ── Component ─────────────────────────────────────────────────────────────────

const PromptComposer: Component = () => {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [ac, setAc] = createSignal<AcState | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = createSignal(false);
  let textareaRef!: HTMLTextAreaElement;
  let mirrorRef!: HTMLPreElement;
  let fieldRef!: HTMLDivElement;
  let leftRef!: HTMLDivElement;
  let actionsRef!: HTMLDivElement;
  let sizerRef!: HTMLPreElement;
  let acListRef: HTMLUListElement | undefined;
  let attachMenuRef: HTMLDivElement | undefined;

  // Race-condition guard for async file listings
  let acSeq = 0;

  const activeTab = () =>
    store.tabs.find((t) => t.sessionId === store.activeTabId) ?? null;
  const hasSession = () => activeTab() !== null;

  const highlighted = createMemo(() =>
    markdownHighlight(escapeHtml(text())) + " "
  );

  // Scroll active AC item into view
  createEffect(
    on(
      () => ac()?.index,
      () => {
        const el = acListRef?.querySelector<HTMLLIElement>(".ac-item--active");
        el?.scrollIntoView({ block: "nearest" });
      }
    )
  );

  // ── Sizing & scroll sync ──────────────────────────────────────────────────

  function syncScroll() {
    if (mirrorRef) mirrorRef.scrollTop = textareaRef.scrollTop;
  }

  // Measure the natural (unwrapped) pixel width of a string using an
  // off-screen <pre white-space:pre> that shares the textarea's font metrics.
  // For multi-line input this returns the width of the widest line.
  function measureWidth(s: string): number {
    if (!sizerRef) return 0;
    sizerRef.textContent = s;
    return sizerRef.scrollWidth;
  }

  // Grows the field horizontally to fit the content (up to the parent's
  // width), then vertically once it wraps — and rounds off the pill into a
  // squarer shape the more it expands in either direction.
  function autoResize() {
    if (!textareaRef || !fieldRef) return;

    // ── Horizontal: fit the widest line, clamped to the parent ──
    const parentW = fieldRef.parentElement?.clientWidth ?? window.innerWidth;
    const sideMargin = 24; // breathing room from the parent edges
    const maxFieldW = Math.max(280, parentW - sideMargin);

    // Everything around the editable body (buttons, gaps, padding).
    const chrome =
      leftRef.offsetWidth +
      actionsRef.offsetWidth +
      24 /* two 12px flex gaps */ +
      28 /* field horizontal padding (14 × 2) */ +
      2; /* sub-pixel safety */

    // Base width keeps the placeholder fully visible so the box never shrinks
    // below its resting size while typing short messages.
    const baseContentW = measureWidth(textareaRef.placeholder ?? "") + 80;
    const textContentW = measureWidth(text());
    const baseW = Math.min(Math.ceil(baseContentW + chrome), maxFieldW);
    const desiredW = Math.ceil(Math.max(baseContentW, textContentW) + chrome);
    const newW = Math.min(Math.max(desiredW, baseW), maxFieldW);
    fieldRef.style.width = newW + "px";

    // ── Vertical: depends on the width we just committed ──
    textareaRef.style.height = "auto";
    const maxH = Math.max(80, Math.floor(window.innerHeight * 0.35));
    const nextH = Math.min(textareaRef.scrollHeight, maxH);
    textareaRef.style.height = nextH + "px";
    textareaRef.style.overflowY =
      textareaRef.scrollHeight > maxH ? "auto" : "hidden";

    // ── Shape: pill (t=0) → squared (t=1) as it fills out ──
    const oneLineH = Math.ceil(13 * 1.65); // single-line textarea height
    const widthT = maxFieldW > baseW ? (newW - baseW) / (maxFieldW - baseW) : 0;
    const heightT = maxH > oneLineH ? (nextH - oneLineH) / (maxH - oneLineH) : 0;
    const t = Math.min(1, Math.max(0, Math.max(widthT, heightT)));
    const squareRadius = 14;
    const pillRadius = fieldRef.offsetHeight / 2;
    const radius = squareRadius + (pillRadius - squareRadius) * (1 - t);
    fieldRef.style.borderRadius = radius + "px";

    syncScroll();
  }

  onMount(() => {
    autoResize();
    const onResize = () => autoResize();
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });

  // ── Autocomplete trigger detection ────────────────────────────────────────

  async function checkTrigger(val: string, cursor: number) {
    const seq = ++acSeq;
    const before = val.slice(0, cursor);

    // @file trigger — @ preceded by start / whitespace / newline
    const fileMatch = before.match(/(?:^|[\s\n])(@[\w./:-]*)$/);
    if (fileMatch && store.currentProject) {
      const fullRef = fileMatch[1]; // "@src/comp"
      const query = fullRef.slice(1); // "src/comp"
      const triggerPos = cursor - fullRef.length;

      const lastSlash = query.lastIndexOf("/");
      const dirPart = lastSlash >= 0 ? query.slice(0, lastSlash) : "";
      const namePart = lastSlash >= 0 ? query.slice(lastSlash + 1) : query;
      const dirPath = dirPart
        ? `${store.currentProject.path}/${dirPart}`
        : store.currentProject.path;

      try {
        const entries = await getFileTree(dirPath);
        if (seq !== acSeq) return;
        const filtered = entries.filter((e) =>
          e.name.toLowerCase().startsWith(namePart.toLowerCase())
        );
        if (filtered.length === 0) { setAc(null); return; }
        setAc({
          kind: "file",
          items: filtered.map((e) => ({
            label: dirPart ? `${dirPart}/${e.name}` : e.name,
            desc: e.is_dir ? "directory" : "file",
            isDir: e.is_dir,
          })),
          index: 0,
          triggerPos,
        });
      } catch {
        if (seq === acSeq) setAc(null);
      }
      return;
    }

    // /command trigger — / at start of input or after a newline
    const cmdMatch = before.match(/(?:^|\n)(\/\w*)$/);
    if (cmdMatch) {
      const partial = cmdMatch[1]; // "/comp"
      const triggerPos = cursor - partial.length;
      const agentId = activeTab()?.agentId ?? "claude";
      const cmds = AGENT_COMMANDS[agentId] ?? AGENT_COMMANDS.claude;
      const filtered = cmds.filter((c) => c.cmd.startsWith(partial));
      if (seq !== acSeq) return;
      if (filtered.length === 0) { setAc(null); return; }
      setAc({
        kind: "command",
        items: filtered.map((c) => ({ label: c.cmd, desc: c.desc, isDir: false })),
        index: 0,
        triggerPos,
      });
      return;
    }

    if (seq === acSeq) setAc(null);
  }

  // ── Apply selected completion ─────────────────────────────────────────────

  function applyCompletion(item: AcItem) {
    const state = ac();
    if (!state) return;

    const cursor = textareaRef.selectionEnd;
    const val = text();

    const insert =
      state.kind === "file"
        ? "@" + item.label + (item.isDir ? "/" : " ")
        : item.label + " ";

    const newVal = val.slice(0, state.triggerPos) + insert + val.slice(cursor);
    setText(newVal);
    setAc(null);

    const newCursor = state.triggerPos + insert.length;
    requestAnimationFrame(() => {
      textareaRef.setSelectionRange(newCursor, newCursor);
      textareaRef.focus();
      autoResize();
    });
  }

  function pathToPromptRef(path: string): string {
    const projectPath = store.currentProject?.path;
    if (!projectPath) return path;

    const prefix = projectPath.endsWith("/") ? projectPath : `${projectPath}/`;
    if (path.startsWith(prefix)) {
      return `@${path.slice(prefix.length)}`;
    }

    return path;
  }

  function insertAtCursor(insert: string) {
    const cursorStart = textareaRef.selectionStart ?? text().length;
    const cursorEnd = textareaRef.selectionEnd ?? cursorStart;
    const val = text();
    const needsLeadingSpace = cursorStart > 0 && !/\s/.test(val[cursorStart - 1]);
    const needsTrailingSpace =
      cursorEnd < val.length && !/\s/.test(val[cursorEnd]) ? " " : "";
    const normalizedInsert = `${needsLeadingSpace ? " " : ""}${insert}${needsTrailingSpace}`;
    const newVal = val.slice(0, cursorStart) + normalizedInsert + val.slice(cursorEnd);
    const newCursor = cursorStart + normalizedInsert.length;

    setText(newVal);
    setAc(null);
    requestAnimationFrame(() => {
      textareaRef.setSelectionRange(newCursor, newCursor);
      textareaRef.focus();
      autoResize();
      checkTrigger(newVal, newCursor);
    });
  }

  async function attachPickedPath(imageOnly = false) {
    if (!hasSession()) return;
    setAttachMenuOpen(false);

    try {
      const path = await pickPromptFile(store.currentProject?.path ?? null, imageOnly);
      if (!path) return;
      insertAtCursor(pathToPromptRef(path));
    } catch (e) {
      console.error("PromptComposer attach failed:", e);
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  function checkpointMessage(prompt: string): string {
    const first = prompt.trimStart().split("\n")[0].slice(0, 72);
    return first || "Checkpoint";
  }

  async function send() {
    const sid = store.activeTabId;
    if (!sid || !text().trim()) return;
    setSending(true);
    try {
      // Checkpoint the working tree before delivering the prompt
      const p = store.currentProject;
      if (p?.is_git) {
        try {
          await ensureWorkBranch(p.path, "ai-work");
          await autoCommit(p.path, checkpointMessage(text())).catch(() => {});
        } catch (e) {
          console.error("checkpoint failed:", e);
        }
      }

      // Send the prompt body, then submit with \r so TUI readline editors
      // (Ink, readline, etc.) register it as Enter rather than a literal newline.
      await ptyInput(sid, text());
      await new Promise((r) => setTimeout(r, 40));
      await ptyInput(sid, "\r");
      clear();
    } catch (e) {
      console.error("PromptComposer send failed:", e);
    } finally {
      setSending(false);
    }
  }

  function clear() {
    setText("");
    setAc(null);
    if (textareaRef) {
      textareaRef.style.overflowY = "hidden";
      autoResize();
    }
  }

  // ── Keyboard UX ──────────────────────────────────────────────────────────

  function onKeyDown(e: KeyboardEvent) {
    const state = ac();

    if (state) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAc((s) => s ? { ...s, index: Math.min(s.index + 1, s.items.length - 1) } : s);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAc((s) => s ? { ...s, index: Math.max(s.index - 1, 0) } : s);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        applyCompletion(state.items[state.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAc(null);
        setAttachMenuOpen(false);
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape" && !state) {
      setAttachMenuOpen(false);
      textareaRef.blur();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={fieldRef!}
      class="prompt-composer__field"
      classList={{ "prompt-composer__field--idle": !hasSession() }}
    >
      {/* Off-screen sizer: measures the natural width of the prompt text */}
      <pre ref={sizerRef!} class="prompt-sizer" aria-hidden="true" />

      <div class="prompt-field-left" ref={leftRef!}>
        <div
          class="prompt-attach-menu"
          ref={attachMenuRef!}
          onFocusOut={() => {
            setTimeout(() => {
              if (!attachMenuRef?.contains(document.activeElement)) {
                setAttachMenuOpen(false);
              }
            }, 0);
          }}
        >
          <button
            class="prompt-btn-attach"
            classList={{ "prompt-btn-attach--open": attachMenuOpen() }}
            disabled={!hasSession() || sending()}
            onClick={() => setAttachMenuOpen((open) => !open)}
            title="Attach"
            aria-haspopup="menu"
            aria-expanded={attachMenuOpen()}
          >
            <svg
              class="prompt-btn-attach-icon"
              aria-hidden="true"
              viewBox="0 -960 960 960"
            >
              <path
                fill="currentColor"
                d="M440-120v-320H120v-80h320v-320h80v320h320v80H520v320h-80Z"
              />
            </svg>
          </button>
          <Show when={attachMenuOpen()}>
            <div class="prompt-attach-dropdown" role="menu">
              <button
                class="prompt-attach-item"
                role="menuitem"
                onClick={() => attachPickedPath()}
              >
                <span class="prompt-btn-icon" aria-hidden="true">📄</span>
                <span>Attach a file</span>
              </button>
              <button
                class="prompt-attach-item"
                role="menuitem"
                onClick={() => attachPickedPath(true)}
              >
                <span class="prompt-btn-icon" aria-hidden="true">🖼️</span>
                <span>Attach an image</span>
              </button>
            </div>
          </Show>
        </div>
      </div>

      {/* Editor body: mirror div + transparent textarea + AC dropdown */}
      <div class="prompt-composer__body">
        <pre
          ref={mirrorRef!}
          class="prompt-mirror"
          aria-hidden="true"
          innerHTML={highlighted()}
        />
        <textarea
          ref={textareaRef!}
          class="prompt-textarea"
          placeholder={
            hasSession()
              ? "Write a message… @file/path  /command  (⌘↵ sends)"
              : "Open an agent tab first"
          }
          disabled={!hasSession() || sending()}
          value={text()}
          rows={1}
          spellcheck={false}
          autocomplete="off"
          onInput={(e) => {
            const val = e.currentTarget.value;
            setText(val);
            autoResize();
            checkTrigger(val, e.currentTarget.selectionEnd);
          }}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onBlur={() => {
            // Small delay so clicks on AC items register before blur closes the list
            setTimeout(() => setAc(null), 120);
          }}
        />

        {/* Autocomplete dropdown */}
        <Show when={ac()}>
          {(state) => (
            <ul class="ac-dropdown" ref={acListRef!}>
              <li class="ac-dropdown__header">
                {state().kind === "file" ? "📄 Files" : "/ Commands"}
              </li>
              <For each={state().items}>
                {(item, i) => (
                  <li
                    class="ac-item"
                    classList={{ "ac-item--active": i() === state().index }}
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent textarea blur
                      setAc((s) => s ? { ...s, index: i() } : s);
                      applyCompletion(item);
                    }}
                    onMouseEnter={() =>
                      setAc((s) => s ? { ...s, index: i() } : s)
                    }
                  >
                    <span class="ac-item__icon">
                      {state().kind === "command"
                        ? "›"
                        : item.isDir
                        ? "📁"
                        : "📄"}
                    </span>
                    <span class="ac-item__label">{item.label}</span>
                    <span class="ac-item__desc">{item.desc}</span>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </div>

      <div class="prompt-field-actions" ref={actionsRef!}>
        <Show when={text().length > 0}>
          <span class="prompt-char-count">{text().length} chars</span>
        </Show>
        <Show when={text().length > 0 && !sending()}>
          <button class="prompt-btn-clear" onClick={clear} title="Discard" aria-label="Discard prompt">
            ×
          </button>
        </Show>
        <button
          class="prompt-btn-send"
          classList={{ "prompt-btn-send--busy": sending() }}
          disabled={!hasSession() || !text().trim() || sending()}
          onClick={send}
          title="Send (⌘↵)"
          aria-label="Send prompt"
        >
          <Show when={!sending()} fallback={<span aria-hidden="true">…</span>}>
            <svg
              class="prompt-btn-send-icon"
              aria-hidden="true"
              viewBox="0 0 24 24"
            >
              <path
                fill="currentColor"
                fill-rule="evenodd"
                d="M16.6915026,12.4744748 L3.50612381,13.2599618 C3.19218622,13.2599618 3.03521743,13.4170592 3.03521743,13.5741566 L1.15159189,20.0151496 C0.8376543,20.8006365 0.99,21.89 1.77946707,22.52 C2.41,22.99 3.50612381,23.1 4.13399899,22.8429026 L21.714504,14.0454487 C22.6563168,13.5741566 23.1272231,12.6315722 22.9702544,11.6889879 C22.8132856,11.0605983 22.3423792,10.4322088 21.714504,10.118014 L4.13399899,1.16346272 C3.34915502,0.9 2.40734225,1.00636533 1.77946707,1.4776575 C0.994623095,2.10604706 0.8376543,3.0486314 1.15159189,3.99121575 L3.03521743,10.4322088 C3.03521743,10.5893061 3.34915502,10.7464035 3.50612381,10.7464035 L16.6915026,11.5318905 C16.6915026,11.5318905 17.1624089,11.5318905 17.1624089,12.0031827 C17.1624089,12.4744748 16.6915026,12.4744748 16.6915026,12.4744748 Z"
              />
            </svg>
          </Show>
        </button>
      </div>
    </div>
  );
};

export default PromptComposer;
