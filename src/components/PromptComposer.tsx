import { Component, createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { store } from "../lib/store";
import {
  autoCommit,
  listPromptSkills,
  pickPromptFile,
  ptyInput,
  searchPromptFiles,
  type FileEntry,
  type PromptSkill,
} from "../lib/ipc";
import { agentColor, AgentLogo } from "../App";
import { getFileIcon } from "./FileTree";

type CompletionKind = "file" | "skill";

interface CompletionToken {
  kind: CompletionKind;
  marker: "@" | "/";
  start: number;
  end: number;
  query: string;
}

interface CompletionItem {
  kind: CompletionKind;
  label: string;
  value: string;
  detail: string;
  isDir?: boolean;
}

function activeCompletionToken(text: string, caret: number): CompletionToken | null {
  const beforeCaret = text.slice(0, caret);
  const match = /(^|\s)([@/][^\s]*)$/.exec(beforeCaret);
  if (!match) return null;

  const token = match[2];
  const marker = token[0] as "@" | "/";
  const start = beforeCaret.length - token.length;

  return {
    kind: marker === "@" ? "file" : "skill",
    marker,
    start,
    end: caret,
    query: token.slice(1),
  };
}

function toPromptPath(path: string, projectPath: string | null | undefined): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedProject = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "");

  if (normalizedProject && normalizedPath.startsWith(`${normalizedProject}/`)) {
    return normalizedPath.slice(normalizedProject.length + 1);
  }

  return normalizedPath;
}

function fileLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const FileSuggestionIcon: Component<{ item: CompletionItem }> = (props) => {
  const iconPath = () => props.item.kind === "file" && !props.item.isDir
    ? getFileIcon(fileLabel(props.item.value))
    : null;

  return (
    <span style={{
      width: "20px", height: "20px",
      display: "flex", "align-items": "center", "justify-content": "center",
      flex: "0 0 auto", color: "#79c0ff",
    }}>
      <Show when={props.item.kind === "skill"} fallback={
        <Show when={props.item.isDir} fallback={
          <Show when={iconPath()} fallback={
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          }>
            <img src={iconPath() ?? ""} alt="" style={{ width: "15px", height: "15px", display: "block" }} />
          </Show>
        }>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4.1c.7 0 1.36.33 1.78.9l.57.76c.14.18.35.29.58.29H18.5A2.5 2.5 0 0 1 21 8.45v8.05A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10Z" />
          </svg>
        </Show>
      }>
        <span style={{
          width: "20px", height: "20px",
          "border-radius": "6px",
          background: "#1a2636",
          color: "#79c0ff",
          display: "flex", "align-items": "center", "justify-content": "center",
          "font-family": "'JetBrains Mono', monospace",
          "font-size": "13px", "font-weight": "700",
        }}>
          /
        </span>
      </Show>
    </span>
  );
};

const PromptComposer: Component = () => {
  const [value, setValue] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const [caretPosition, setCaretPosition] = createSignal(0);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [dismissedTokenKey, setDismissedTokenKey] = createSignal<string | null>(null);
  let textareaRef!: HTMLTextAreaElement;

  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const activeColor = () => activeTab() ? agentColor(activeTab()!.agentId) : "#8b949e";
  const placeholder = () => {
    const tab = activeTab();
    if (tab) return `Prompt ${tab.label}`;
    if (store.currentProject) return "No agent running - enter commit message";
    return "Open a project or start an agent";
  };

  const completionToken = createMemo(() => activeCompletionToken(value(), caretPosition()));
  const completionTokenKey = createMemo(() => {
    const token = completionToken();
    return token ? `${token.kind}:${token.start}:${token.query}` : null;
  });
  const fileSearchKey = createMemo(() => {
    const token = completionToken();
    const project = store.currentProject;
    return token?.kind === "file" && project
      ? { projectPath: project.path, query: token.query }
      : null;
  });

  const [fileSuggestions] = createResource(
    fileSearchKey,
    (key) => key ? searchPromptFiles(key.projectPath, key.query, 10) : Promise.resolve([]),
  );

  const [skills] = createResource(
    () => store.currentProject?.path ?? "",
    (projectPath) => listPromptSkills(projectPath || null),
  );

  const skillItems = createMemo<CompletionItem[]>(() => {
    const token = completionToken();
    if (token?.kind !== "skill") return [];

    const query = token.query.toLowerCase();
    return (skills() ?? [])
      .filter((skill: PromptSkill) => {
        const name = skill.name.toLowerCase();
        return !query || name.startsWith(query) || name.includes(query);
      })
      .slice(0, 10)
      .map((skill) => ({
        kind: "skill",
        label: skill.name,
        value: skill.name,
        detail: skill.description || `${skill.source} skill`,
      }));
  });

  const fileItems = createMemo<CompletionItem[]>(() => {
    const token = completionToken();
    if (token?.kind !== "file") return [];

    return (fileSuggestions() ?? []).map((entry: FileEntry) => ({
      kind: "file",
      label: fileLabel(entry.name),
      value: entry.name,
      detail: entry.name,
      isDir: entry.is_dir,
    }));
  });

  const completionItems = createMemo(() => {
    const token = completionToken();
    if (!token) return [];
    return token.kind === "file" ? fileItems() : skillItems();
  });

  const showCompletions = () =>
    focused() &&
    completionItems().length > 0 &&
    completionTokenKey() !== dismissedTokenKey();

  createEffect(() => {
    const token = completionToken();
    completionItems().length;
    token?.query;
    token?.kind;
    setSelectedIndex(0);
  });

  function syncCaret() {
    setCaretPosition(textareaRef?.selectionStart ?? value().length);
  }

  function focusAt(caret: number) {
    queueMicrotask(() => {
      textareaRef.focus();
      textareaRef.setSelectionRange(caret, caret);
      setCaretPosition(caret);
    });
  }

  function insertAtCaret(text: string) {
    const start = textareaRef.selectionStart ?? value().length;
    const end = textareaRef.selectionEnd ?? start;
    const next = `${value().slice(0, start)}${text}${value().slice(end)}`;
    const caret = start + text.length;
    setValue(next);
    setDismissedTokenKey(null);
    focusAt(caret);
  }

  function applyCompletion(item: CompletionItem) {
    const token = completionToken();
    if (!token) return;

    const suffix = item.kind === "file" && item.isDir ? "/" : " ";
    const replacement = `${token.marker}${item.value}${suffix}`;
    const next = `${value().slice(0, token.start)}${replacement}${value().slice(token.end)}`;
    const caret = token.start + replacement.length;
    setValue(next);
    setDismissedTokenKey(null);
    focusAt(caret);
  }

  async function pickFile() {
    const picked = await pickPromptFile(store.currentProject?.path ?? null, false);
    if (!picked) return;

    const ref = toPromptPath(picked, store.currentProject?.path);
    if (!ref) return;
    insertAtCaret(`@${ref} `);
  }

  async function send() {
    const text = value().trim();
    if (!text || sending()) return;

    const tab = activeTab();
    setSending(true);

    try {
      if (tab) {
        await ptyInput(tab.sessionId, text + "\r");
      } else if (store.currentProject) {
        await autoCommit(store.currentProject.path, text);
      }
      setValue("");
      setCaretPosition(0);
      setDismissedTokenKey(null);
    } catch (e) {
      console.error(e);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (showCompletions()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((index) => (index + 1) % completionItems().length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((index) => (index - 1 + completionItems().length) % completionItems().length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applyCompletion(completionItems()[selectedIndex()]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedTokenKey(completionTokenKey());
        return;
      }
    }

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
        position: "relative",
        display: "flex", "align-items": "center", gap: "10px",
        background: "#14161d",
        border: `1px solid ${activeColor()}55`,
        "border-radius": "11px",
        padding: "11px 12px",
        "box-shadow": `0 0 0 3px ${activeColor()}14`,
      }}>
        <Show when={showCompletions()}>
          <div style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "calc(100% + 8px)",
            background: "#14161d",
            border: "1px solid #2a2e3a",
            "border-radius": "11px",
            "box-shadow": "0 24px 60px rgba(0,0,0,.65)",
            padding: "7px",
            "z-index": "60",
            "max-height": "284px",
            overflow: "auto",
          }}>
            <For each={completionItems()}>
              {(item, index) => {
                const active = () => index() === selectedIndex();
                return (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onclick={() => applyCompletion(item)}
                    style={{
                      width: "100%",
                      display: "flex",
                      "align-items": "center",
                      gap: "10px",
                      padding: "8px 10px",
                      "border-radius": "8px",
                      "text-align": "left",
                      background: active() ? "#1b1f2a" : "transparent",
                    }}
                  >
                    <FileSuggestionIcon item={item} />
                    <div style={{ flex: "1", "min-width": 0 }}>
                      <div style={{
                        display: "flex", "align-items": "center", gap: "8px",
                        color: "var(--fg-default)",
                        "font-size": "13px",
                        "font-weight": "500",
                        "min-width": 0,
                      }}>
                        <span style={{
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}>
                          {item.kind === "skill" ? `/${item.label}` : item.label}
                        </span>
                        <Show when={item.isDir}>
                          <span style={{ color: "var(--fg-subtle)", "font-size": "11px" }}>/</span>
                        </Show>
                      </div>
                      <div style={{
                        color: "var(--fg-subtle)",
                        "font-family": "'JetBrains Mono', monospace",
                        "font-size": "10.5px",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                      }}>
                        {item.detail}
                      </div>
                    </div>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={activeTab()} fallback={
          <span style={{
            width: "20px", height: "20px", "border-radius": "6px",
            background: "#1a1d25", color: "#6e7681",
            display: "flex", "align-items": "center", "justify-content": "center",
            flex: "0 0 auto",
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </span>
        }>
          {(tab) => (
            <AgentLogo
              agentId={tab().agentId}
              icon={tab().agentIcon}
              name={tab().label}
              size={20}
              radius={6}
            />
          )}
        </Show>

        <button
          type="button"
          onclick={pickFile}
          disabled={!store.currentProject}
          title="Attach file"
          style={{
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "30px", height: "30px",
            "border-radius": "8px",
            color: store.currentProject ? "var(--fg-subtle)" : "#3a3d47",
            background: "#1a1d25",
            flex: "0 0 auto",
            cursor: store.currentProject ? "pointer" : "default",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.4 11.1 12 20.5a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.4 9.4a2 2 0 0 1-2.8-2.8l8.7-8.7" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={placeholder()}
          value={value()}
          onInput={(e) => {
            setValue(e.currentTarget.value);
            setCaretPosition(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            setDismissedTokenKey(null);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onFocus={() => {
            setFocused(true);
            syncCaret();
          }}
          onBlur={() => setFocused(false)}
          style={{
            flex: "1",
            "min-width": 0,
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

        <Show when={!activeTab()}>
          <span style={{
            "font-family": "'JetBrains Mono', monospace",
            "font-size": "10.5px", color: "var(--fg-subtle)",
            border: "1px solid #262a35", "border-radius": "6px",
            padding: "3px 8px", flex: "0 0 auto",
          }}>
            Commit
          </span>
        </Show>

        <button
          type="button"
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
