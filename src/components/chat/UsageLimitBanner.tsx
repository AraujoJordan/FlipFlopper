import { Component, Show, createSignal } from "solid-js";
import { chat, sendPromptTo, snoozeSession, splitMode } from "../../lib/chat";
import { usageLimitSignal } from "../../lib/transcript";
import { providerUsageLimits } from "../../lib/ipc";
import { addScheduleAt } from "../../lib/schedule";
import { toast } from "../ui";
import { fallbackModel } from "../../lib/settings";
import { Icon } from "../shell/Icon";

const RESUME_PROMPT = "Continue from where you left off. The previous turn stopped because the provider's usage limit was reached. Do not repeat completed work.";

/** A finished turn stopped on a provider limit. The user can resume immediately,
 *  schedule a resume at the next reset, or snooze the conversation until then. */
const UsageLimitBanner: Component = () => {
  const [dismissed, setDismissed] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const sessionId = () => chat.activeId;
  const meta = () => chat.sessions.find((session) => session.id === sessionId());
  const view = () => { const id = sessionId(); return id ? chat.views[id] : undefined; };
  const signal = () => { const current = view(); return current ? usageLimitSignal(current) : null; };
  const visible = () => {
    const current = signal();
    const id = sessionId();
    return !!current && !!id && dismissed() !== `${id}:${current.title}` && !view()?.running;
  };

  async function resetAt(): Promise<number | null> {
    const agent = meta()?.agent_id;
    if (!agent) return null;
    try {
      const limits = await providerUsageLimits(agent);
      const now = Date.now();
      const times = limits.windows.map((window) => window.reset_at ?? 0).filter((time) => time > now);
      return times.length ? Math.min(...times) : null;
    } catch {
      return null;
    }
  }

  async function resume() {
    const id = sessionId();
    const current = meta();
    if (!id || !current || busy()) return;
    setBusy(true);
    try {
      const sent = await sendPromptTo(id, RESUME_PROMPT, { agentId: current.agent_id, ...splitMode(current.mode, current.yolo) });
      if (sent) toast("Resumed after the usage limit", "success");
    } finally {
      setBusy(false);
    }
  }

  async function resumeFallback() {
    const id = sessionId();
    const current = meta();
    const model = fallbackModel().trim();
    if (!id || !current || !model || busy()) return;
    setBusy(true);
    try {
      const sent = await sendPromptTo(id, RESUME_PROMPT, { agentId: current.agent_id, ...splitMode(current.mode, current.yolo), model });
      if (sent) toast(`Resumed on ${model}`, "success");
    } finally {
      setBusy(false);
    }
  }

  async function resumeAtReset() {
    const id = sessionId();
    const current = meta();
    if (!id || !current || busy()) return;
    setBusy(true);
    try {
      const at = await resetAt();
      if (!at) { toast("The provider did not report a reset time. Try Resume once the limit clears.", "info"); return; }
      const error = addScheduleAt(
        { session_id: id, project_path: current.project_path, agent_id: current.agent_id },
        RESUME_PROMPT,
        at,
        "Resume after usage limit",
      );
      if (error) toast(error, "error");
      else toast(`Resume scheduled for ${new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, "success");
    } finally {
      setBusy(false);
    }
  }

  async function snoozeUntilReset() {
    const id = sessionId();
    if (!id || busy()) return;
    setBusy(true);
    try {
      const at = await resetAt();
      if (!at) { toast("The provider did not report a reset time. Resume manually when the limit clears.", "info"); return; }
      await snoozeSession(id, at);
      toast(`Snoozed until ${new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, "info");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={visible() ? signal() : null}>
      {(current) => (
        <div class="usage-limit-banner" role="alert">
          <Icon name="alert" size={15} />
          <div class="usage-limit-copy">
            <strong>{current().title}</strong>
            <Show when={current().description}><span>{current().description}</span></Show>
          </div>
          <div class="usage-limit-actions">
            <button type="button" class="ui-btn ui-btn-outline" disabled={busy()} onClick={() => void resume()}>Resume</button>
            <Show when={fallbackModel().trim()}>
              {(model) => <button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void resumeFallback()}>Use {model()}</button>}
            </Show>
            <button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void resumeAtReset()}>Resume at reset</button>
            <button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void snoozeUntilReset()}>Snooze until reset</button>
            <button type="button" class="icon-btn" title="Dismiss" aria-label="Dismiss usage limit notice" onClick={() => { const id = sessionId(); if (id) setDismissed(`${id}:${current().title}`); }}><Icon name="x" size={12} /></button>
          </div>
        </div>
      )}
    </Show>
  );
};

export default UsageLimitBanner;
