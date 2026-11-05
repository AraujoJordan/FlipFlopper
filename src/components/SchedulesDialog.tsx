import { Presence } from "./ui";
import { Icon } from "./shell/Icon";
import { Component, For, Show, createSignal } from "solid-js";
import { chat, projectName, selectSession } from "../lib/chat";
import { store } from "../lib/store";
import {
  addSchedule, deleteSchedule, describeRule, parseScheduleSpec, runSchedule, schedules,
  schedulesOpen, setSchedulesOpen, toggleSchedule, updateSchedule, type Schedule, type ScheduleRule,
} from "../lib/schedule";

const when = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
const stamp = (ms: number) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Rule back into the short `/schedule` syntax used by the editor. */
function specForRule(rule: ScheduleRule): string {
  if (rule.kind === "every") return `every ${rule.minutes % 60 === 0 ? `${rule.minutes / 60}h` : `${rule.minutes}m`}`;
  if (rule.kind === "daily") return `${rule.weekdays?.length === 5 ? "weekdays" : "daily"} ${rule.time}`;
  return `in ${Math.max(1, Math.ceil((rule.at - Date.now()) / 60_000))}m`;
}

const nameOf = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};

/** Lists scheduled prompts and edits them. The `/schedule` command still creates
 *  one quickly; this dialog is the fuller form with a destination choice. */
const SchedulesDialog: Component = () => {
  const close = () => { resetForm(); setSchedulesOpen(false); };
  const [formOpen, setFormOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [formPrompt, setFormPrompt] = createSignal("");
  const [formSpec, setFormSpec] = createSignal("every 30m");
  const [formName, setFormName] = createSignal("");
  const [formNewSession, setFormNewSession] = createSignal(false);
  const [formError, setFormError] = createSignal<string | null>(null);

  const activeSession = () => chat.sessions.find((session) => session.id === chat.activeId) ?? null;
  const projectPath = () => activeSession()?.project_path ?? store.currentProject?.path ?? null;
  const agentId = () => activeSession()?.agent_id ?? chat.composer.agentId;
  const targetLabel = (t: Schedule["target"]) =>
    "session_id" in t ? chat.sessions.find((s) => s.id === t.session_id)?.title || "Session" : `New session · ${projectName(t.project_path)}`;

  function resetForm() {
    setFormOpen(false);
    setEditingId(null);
    setFormPrompt("");
    setFormSpec("every 30m");
    setFormName("");
    setFormNewSession(false);
    setFormError(null);
  }

  function startNew() {
    resetForm();
    setFormOpen(true);
    setFormNewSession(!chat.activeId);
  }

  function startEdit(schedule: Schedule) {
    setEditingId(schedule.id);
    setFormPrompt(schedule.prompt);
    setFormSpec(specForRule(schedule.rule));
    setFormName(schedule.name);
    setFormNewSession("project_path" in schedule.target);
    setFormError(null);
    setFormOpen(true);
  }

  function submit(event: Event) {
    event.preventDefault();
    const prompt = formPrompt().trim();
    if (!prompt) { setFormError("Add a prompt."); return; }
    const spec = formSpec().trim();
    if (!spec) { setFormError("Add a schedule like “every 30m” or “daily 09:00”."); return; }
    const parsed = parseScheduleSpec(`${formNewSession() ? "new " : ""}${spec} ${prompt}`);
    if (typeof parsed === "string") { setFormError(parsed); return; }
    const existing = schedules.find((schedule) => schedule.id === editingId());
    const newTarget = formNewSession() || !chat.activeId;
    const target = newTarget
      ? (projectPath() ? { project_path: projectPath()!, agent_id: agentId() } : null)
      : ("session_id" in (existing?.target ?? {}) ? existing!.target : (chat.activeId ? { session_id: chat.activeId } : null));
    if (!target) { setFormError("Open a project or session first."); return; }
    if (existing) {
      updateSchedule(existing.id, {
        name: formName().trim() || nameOf(parsed.prompt),
        prompt: parsed.prompt,
        rule: parsed.rule,
        target,
        paused: false,
      });
      resetForm();
      return;
    }
    const error = addSchedule(
      { session_id: chat.activeId, project_path: projectPath(), agent_id: agentId() },
      `${formNewSession() ? "new " : ""}${spec} ${prompt}`,
    );
    if (error) { setFormError(error); return; }
    resetForm();
  }

  return (
    <Presence when={schedulesOpen()}>
      <div class="overlay-backdrop-in" onclick={close}
        style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.48)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in" tabindex={-1} onclick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}
          ref={(el) => queueMicrotask(() => el.focus())}
          style={{ width: "min(560px, 100%)", "max-height": "82vh", overflow: "auto", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)", padding: "18px 20px" }}>
          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "12px" }}>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)" }}>Scheduled prompts</span>
            <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
              <button class="ui-btn ui-btn-ghost" type="button" onClick={startNew} title="Create a scheduled prompt">
                <Icon name="plus" size={12} /> New
              </button>
              <button class="icon-btn press" onclick={close} title="Close" aria-label="Close scheduled prompts" style={{ display: "flex", padding: "3px", color: "var(--fg-subtle)" }}><Icon name="x" size={13} /></button>
            </div>
          </div>
          <div style={{ "font-size": "12px", color: "var(--fg-muted)", "margin-bottom": "12px" }}>
            Delivered while FlipFlopper is open. Schedules can continue the open session or start a fresh one each run.
          </div>

          <Show when={formOpen()}>
            <form class="scripts-form" onSubmit={submit} style={{ "margin-bottom": "14px" }}>
              <div class="scripts-form-head">
                <Icon name="history" size={15} />
                <strong>{editingId() ? "Edit schedule" : "New schedule"}</strong>
                <button type="button" class="link-btn" onClick={resetForm}>Cancel</button>
              </div>
              <label class="scripts-field">
                <span>Prompt</span>
                <textarea class="ui-field" rows={3} value={formPrompt()} placeholder="Review the open pull requests and summarize risks"
                  onInput={(event) => { setFormPrompt(event.currentTarget.value); setFormError(null); }} />
              </label>
              <div class="scripts-fields">
                <label class="scripts-field scripts-field-name">
                  <span>Name</span>
                  <input class="ui-field" value={formName()} placeholder={nameOf(formPrompt()) || "Optional name"}
                    onInput={(event) => setFormName(event.currentTarget.value)} />
                </label>
                <label class="scripts-field">
                  <span>Schedule</span>
                  <input class="ui-field" value={formSpec()} placeholder="every 30m"
                    spellcheck={false} onInput={(event) => { setFormSpec(event.currentTarget.value); setFormError(null); }} />
                </label>
              </div>
              <div style={{ "font-size": "11.5px", color: "var(--fg-subtle)" }}>
                Try <code>every 30m</code>, <code>daily 09:00</code>, <code>weekdays 09:00</code>, <code>once 14:30</code> or <code>in 2h</code>.
              </div>
              <label style={{ display: "flex", "align-items": "center", gap: "7px", "font-size": "12.5px", color: "var(--fg-body)" }}>
                <input type="checkbox" checked={formNewSession()} onChange={(event) => setFormNewSession(event.currentTarget.checked)} />
                Start a new session each run{projectPath() ? ` in ${projectName(projectPath()!)}` : ""}
              </label>
              <Show when={formError()}>{(message) => <p class="scripts-error" role="alert">{message()}</p>}</Show>
              <div class="scripts-form-actions">
                <button type="submit" class="ui-btn ui-btn-outline">
                  <Icon name="check" size={13} /> {editingId() ? "Save changes" : "Create schedule"}
                </button>
              </div>
            </form>
          </Show>

          <Show when={schedules.length > 0} fallback={<div style={{ "font-size": "12.5px", color: "var(--fg-subtle)" }}>Nothing scheduled. Create one above.</div>}>
            <For each={schedules}>
              {(s) => (
                <div style={{ display: "flex", "align-items": "center", gap: "8px", padding: "8px 0", "border-top": "1px solid var(--border-default)", opacity: s.paused ? 0.6 : 1 }}>
                  <div style={{ flex: 1, "min-width": 0 }}>
                    <div style={{ "font-size": "12.5px", color: "var(--fg-default)", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }} title={s.prompt}>{s.name || s.prompt}</div>
                    <div style={{ "font-size": "11px", color: "var(--fg-subtle)" }}>
                      {describeRule(s.rule)} · {targetLabel(s.target)} · {s.ended ? "done" : s.paused ? "paused" : `next ${when(s.next_run)}`}
                    </div>
                    <Show when={s.runs.length > 0}>
                      <details style={{ "margin-top": "4px" }}>
                        <summary style={{ "font-size": "11px", color: "var(--fg-muted)", cursor: "pointer" }}>History ({s.runs.length})</summary>
                        <For each={s.runs.slice(0, 8)}>
                          {(r) => (
                            <div style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "11px", padding: "2px 0", color: r.ok ? "var(--fg-muted)" : "var(--status-del)" }}>
                              <span>{stamp(r.at)}</span>
                              <span style={{ flex: 1, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }} title={r.error}>{r.ok ? "Delivered" : r.error}</span>
                              <Show when={r.session_id && chat.sessions.some((x) => x.id === r.session_id)}>
                                <button class="ui-btn ui-btn-ghost" onclick={() => { close(); void selectSession(r.session_id!); }}>Open</button>
                              </Show>
                            </div>
                          )}
                        </For>
                      </details>
                    </Show>
                  </div>
                  <button class="ui-btn ui-btn-ghost" onclick={() => startEdit(s)} title="Edit schedule">Edit</button>
                  <button class="ui-btn ui-btn-ghost" onclick={() => void runSchedule({ ...s })} title="Run now">Run</button>
                  <Show when={!s.ended}><button class="ui-btn ui-btn-ghost" onclick={() => toggleSchedule(s.id)}>{s.paused ? "Resume" : "Pause"}</button></Show>
                  <button class="icon-btn press" onclick={() => deleteSchedule(s.id)} title="Delete" aria-label="Delete schedule"><Icon name="trash" size={13} /></button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Presence>
  );
};

export default SchedulesDialog;
