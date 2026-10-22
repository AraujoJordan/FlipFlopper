import { Component, For, Show, createSignal } from "solid-js";
import type { ToolBlock } from "../../lib/chat";
import type { ToolKind } from "../../lib/ipc";
import { Icon, type IconName } from "../shell/Icon";
import { Spinner } from "../ui";
import InlineDiff, { DiffStat, diffFromInput } from "./InlineDiff";

const KIND_ICON: Record<ToolKind, IconName> = {
  read: "file",
  edit: "pencil",
  write: "pencil",
  bash: "terminal",
  search: "search",
  web: "globe",
  todo: "list",
  other: "wrench",
};

// [while running, when finished]
const KIND_VERB: Record<ToolKind, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  write: ["Writing", "Wrote"],
  bash: ["Running", "Ran"],
  search: ["Searching", "Searched"],
  web: ["Fetching", "Fetched"],
  todo: ["Updating", "Updated"],
  other: ["Using", "Used"],
};

interface Todo { text: string; done: boolean; active: boolean }

/** Checklist items from a todo tool call (Claude `TodoWrite`, Codex `todo_list`). */
function todosOf(input: unknown): Todo[] | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const raw = Array.isArray(obj.todos) ? obj.todos : Array.isArray(obj.items) ? obj.items : null;
  if (!raw) return null;
  const todos = raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      text: String(t.content ?? t.text ?? t.title ?? ""),
      done: t.status === "completed" || t.completed === true,
      active: t.status === "in_progress",
    }))
    .filter((t) => t.text);
  return todos.length > 0 ? todos : null;
}

function inputText(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

const ToolCallRow: Component<{ block: ToolBlock }> = (props) => {
  const todos = () => (props.block.toolKind === "todo" ? todosOf(props.block.input) : null);
  const [open, setOpen] = createSignal(props.block.toolKind === "todo" && !!todosOf(props.block.input));
  const diff = () => diffFromInput(props.block.toolKind, props.block.input);
  const verb = () => KIND_VERB[props.block.toolKind][props.block.status === "running" ? 0 : 1];
  const command = () => {
    const input = props.block.input;
    if (props.block.toolKind !== "bash" || !input || typeof input !== "object") return "";
    const c = (input as Record<string, unknown>).command;
    return typeof c === "string" ? c : "";
  };
  const title = () => {
    const t = todos();
    return t ? `Todos (${t.filter((x) => x.done).length}/${t.length} done)` : props.block.title;
  };
  const hasDetail = () => !!todos() || !!diff() || !!props.block.output || !!command() || props.block.input != null;

  return (
    <div class="tool-row" classList={{ "tool-row-error": props.block.status === "error" }}>
      <button
        type="button"
        class="tool-row-head"
        onClick={() => hasDetail() && setOpen((v) => !v)}
        aria-expanded={open()}
      >
        <Icon name={KIND_ICON[props.block.toolKind]} size={14} />
        <span class="tool-row-verb">{verb()}</span>
        <span class="tool-row-title">{title()}</span>
        <Show when={diff()}>{(d) => <DiffStat adds={d().adds} dels={d().dels} />}</Show>
        <span class="tool-row-state">
          <Show when={props.block.status === "running"}><Spinner size={12} /></Show>
          <Show when={props.block.status === "error"}><Icon name="x" size={13} /></Show>
          <Show when={hasDetail()}>
            <Icon name="chevronRight" size={13} style={{ transform: open() ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }} />
          </Show>
        </span>
      </button>
      <Show when={open()}>
        <div class="tool-row-body">
          <Show when={todos()}>
            {(list) => (
              <ul class="todo-list">
                <For each={list()}>
                  {(t) => (
                    <li classList={{ "todo-done": t.done, "todo-active": t.active }}>
                      <span class="todo-box">{t.done ? "✓" : t.active ? "•" : ""}</span>
                      <span>{t.text}</span>
                    </li>
                  )}
                </For>
              </ul>
            )}
          </Show>
          <Show when={!todos() && diff()}>{(d) => <InlineDiff diff={d()} />}</Show>
          <Show when={!todos() && !diff() && command()}>
            <pre class="tool-pre"><span class="tool-prompt">$ </span>{command()}</pre>
          </Show>
          <Show when={!todos() && !diff() && !command() && props.block.input != null}>
            <pre class="tool-pre">{inputText(props.block.input)}</pre>
          </Show>
          <Show when={props.block.output}>
            <pre class="tool-pre tool-pre-output">{props.block.output}</pre>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default ToolCallRow;
