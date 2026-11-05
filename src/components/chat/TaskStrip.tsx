import { Component, Index, Show, createMemo, createSignal } from "solid-js";
import { activeView, chat, isRunning } from "../../lib/chat";
import { latestTodos } from "../../lib/transcript";
import { Disclosure } from "../ui";
import { Icon } from "../shell/Icon";

/** The agent's standing task list, kept visible above the composer while work remains. */
const TaskStrip: Component = () => {
  const [open, setOpen] = createSignal(false);
  const todos = createMemo(() => latestTodos(activeView()));
  const done = () => todos()?.filter((t) => t.done).length ?? 0;
  const remaining = () => (todos()?.length ?? 0) - done();
  const running = () => !!chat.activeId && isRunning(chat.activeId);
  const current = () => todos()?.find((t) => t.active) ?? todos()?.find((t) => !t.done);
  return (
    <Show when={todos() && (remaining() > 0 || running())}>
      <div class="task-strip" style={{ margin: "0 0 8px", border: "1px solid var(--border-default)", "border-radius": "var(--radius-lg)", background: "var(--surface-2)", overflow: "hidden" }}>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open()} aria-label="Task progress"
          style={{ display: "flex", "align-items": "center", gap: "8px", width: "100%", padding: "7px 12px", background: "none", border: "none", color: "var(--fg-body)", "font-size": "12.5px", "text-align": "left", cursor: "pointer" }}>
          <Icon name="list" size={14} />
          <span style={{ "font-weight": "600", "white-space": "nowrap" }}>Tasks {done()}/{todos()!.length}</span>
          <span style={{ flex: 1, "min-width": 0, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--fg-muted)" }}>{current()?.text}</span>
          <span aria-hidden="true" style={{ width: "56px", height: "4px", "border-radius": "2px", background: "var(--surface-4)", overflow: "hidden", flex: "0 0 56px" }}>
            <span style={{ display: "block", height: "100%", width: `${(done() / todos()!.length) * 100}%`, background: "var(--status-add)", transition: "width var(--dur-base)" }} />
          </span>
          <Icon name="chevronRight" size={12} style={{ transform: open() ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }} />
        </button>
        <Disclosure open={open()} class="tool-row-body">
          <ul class="todo-list">
            <Index each={todos()!}>
              {(t) => (
                <li classList={{ "todo-done": t().done, "todo-active": t().active }}>
                  <span class="todo-box">{t().done ? "✓" : t().active ? "•" : ""}</span>
                  <span>{t().text}</span>
                </li>
              )}
            </Index>
          </ul>
        </Disclosure>
      </div>
    </Show>
  );
};

export default TaskStrip;
