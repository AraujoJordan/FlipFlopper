import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import { store } from "../lib/store";
import { autoCommit, ensureWorkBranch, getFileTree, ptyInput } from "../lib/ipc";

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
  gemini: [
    { cmd: "/help",   desc: "Show help" },
    { cmd: "/clear",  desc: "Clear conversation" },
    { cmd: "/memory", desc: "Show memory" },
    { cmd: "/chat",   desc: "Enter chat mode" },
    { cmd: "/tools",  desc: "List available tools" },
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
  let textareaRef!: HTMLTextAreaElement;
  let mirrorRef!: HTMLPreElement;
  let acListRef: HTMLUListElement | undefined;

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

  function autoResize() {
    textareaRef.style.height = "auto";
    const maxH = Math.max(80, Math.floor(window.innerHeight * 0.35));
    const nextH = Math.min(textareaRef.scrollHeight, maxH);
    textareaRef.style.height = nextH + "px";
    textareaRef.style.overflowY =
      textareaRef.scrollHeight > maxH ? "auto" : "hidden";
    syncScroll();
  }

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

  // ── Send ──────────────────────────────────────────────────────────────────

  function checkpointMessage(prompt: string): string {
    const first = prompt.trimStart().split("\n")[0].slice(0, 72);
    return `checkpoint: ${first}`;
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
      textareaRef.style.height = "auto";
      textareaRef.style.overflowY = "hidden";
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
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === "Escape" && !state) {
      textareaRef.blur();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      class="prompt-composer"
      classList={{ "prompt-composer--idle": !hasSession() }}
    >
      {/* Agent target label */}
      <div class="prompt-composer__header">
        <Show
          when={activeTab()}
          fallback={
            <span class="prompt-header-hint">
              Open an agent tab to start composing
            </span>
          }
        >
          {(tab) => (
            <>
              <span class="prompt-header-icon">{tab().agentIcon}</span>
              <span class="prompt-header-name">{tab().label}</span>
              <span class="prompt-header-sep">·</span>
              <span class="prompt-header-hint">
                markdown · @file · /command · (⌘↵ sends)
              </span>
            </>
          )}
        </Show>
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
              ? "Write a message… @file/path  /command  **bold**  `code`  (⌘↵ sends)"
              : "Open an agent tab first"
          }
          disabled={!hasSession() || sending()}
          value={text()}
          rows={2}
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

      {/* Toolbar */}
      <div class="prompt-composer__footer">
        <span class="prompt-footer-meta">
          <Show when={text().length > 0}>
            <span class="prompt-char-count">{text().length} chars</span>
          </Show>
        </span>

        <div class="prompt-footer-actions">
          <Show when={text().length > 0 && !sending()}>
            <button class="prompt-btn-clear" onClick={clear} title="Discard">
              Clear
            </button>
          </Show>
          <button
            class="prompt-btn-send"
            classList={{ "prompt-btn-send--busy": sending() }}
            disabled={!hasSession() || !text().trim() || sending()}
            onClick={send}
            title="Send (⌘↵)"
          >
            <Show when={!sending()} fallback={<span>Sending…</span>}>
              <span>Send</span>
              <kbd class="prompt-kbd">⌘↵</kbd>
            </Show>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PromptComposer;
