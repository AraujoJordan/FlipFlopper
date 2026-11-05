import { Component, Show, createEffect, createSignal } from "solid-js";
import { Presence, toast } from "./ui";
import { Icon } from "./shell/Icon";
import { snoozeSessions } from "../lib/chat";
import { resolveSnoozeDate, resolveSnoozeDuration, snoozeDateValue, snoozeTimeValue, type SnoozeUnit } from "../lib/snooze";

interface SnoozeRequest {
  ids: string[];
  title?: string;
}

const [request, setRequest] = createSignal<SnoozeRequest | null>(null);

/** Open the custom snooze dialog for one session or a sidebar selection. */
export function requestCustomSnooze(ids: readonly string[], title?: string) {
  if (ids.length === 0) return;
  setRequest({ ids: [...ids], title });
}

/** Custom "snooze until" dialog: a local date and time, or a duration. */
const SnoozeDialog: Component = () => {
  const [mode, setMode] = createSignal<"date" | "duration">("date");
  const [date, setDate] = createSignal("");
  const [time, setTime] = createSignal("09:00");
  const [amount, setAmount] = createSignal("2");
  const [unit, setUnit] = createSignal<SnoozeUnit>("hours");
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  // Kept while the dialog animates out, so the heading does not briefly read "0 sessions".
  const [heading, setHeading] = createSignal("Snooze session");

  // Every opening starts from a sensible future default (tomorrow 09:00).
  createEffect(() => {
    const pending = request();
    if (!pending) return;
    setHeading(pending.ids.length === 1
      ? (pending.title ? `Snooze “${pending.title}”` : "Snooze session")
      : `Snooze ${pending.ids.length} sessions`);
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setHours(9, 0, 0, 0);
    setMode("date");
    setDate(snoozeDateValue(tomorrow));
    setTime(snoozeTimeValue(tomorrow));
    setAmount("2");
    setUnit("hours");
    setError(null);
    setSaving(false);
  });

  const close = () => { if (!saving()) setRequest(null); };
  /** Local time the session comes back, for a quick sanity check before saving. */
  const preview = () => {
    const until = mode() === "date" ? resolveSnoozeDate(date(), time()) : resolveSnoozeDuration(amount(), unit());
    return until === null ? null : new Date(until).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const count = () => request()?.ids.length ?? 0;

  async function submit(event: Event) {
    event.preventDefault();
    const pending = request();
    if (!pending || saving()) return;
    const now = Date.now();
    const until = mode() === "date" ? resolveSnoozeDate(date(), time(), now) : resolveSnoozeDuration(amount(), unit(), now);
    if (until === null) {
      setError(mode() === "date" ? "Choose a valid date and time in the future." : "Enter a positive duration of at least one minute.");
      return;
    }
    setSaving(true);
    const changed = await snoozeSessions(pending.ids, until);
    setSaving(false);
    setRequest(null);
    if (changed === 0) toast("Those sessions could not be snoozed.", "error");
  }

  return (
    <Presence when={request() !== null}>
      <div class="overlay-backdrop-in snooze-backdrop" onClick={close}>
        <form
          class="overlay-pop-in snooze-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="snooze-title"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}
          onSubmit={submit}
        >
          <header class="snooze-head">
            <div class="snooze-heading">
              <strong id="snooze-title">{heading()}</strong>
              <span>Choose when {count() === 1 ? "it returns" : "they return"} to your sidebar.</span>
            </div>
            <button type="button" class="icon-btn press" aria-label="Close" title="Close" onClick={close}><Icon name="x" size={14} /></button>
          </header>

          <div class="snooze-body">
            <div class="seg" role="group" aria-label="Snooze by">
              <button type="button" class="seg-btn" aria-pressed={mode() === "date"} classList={{ "seg-on": mode() === "date" }} onClick={() => { setMode("date"); setError(null); }}>Date and time</button>
              <button type="button" class="seg-btn" aria-pressed={mode() === "duration"} classList={{ "seg-on": mode() === "duration" }} onClick={() => { setMode("duration"); setError(null); }}>Duration</button>
            </div>

            <Show
              when={mode() === "date"}
              fallback={
                <div class="snooze-fields">
                  <label class="snooze-field">
                    <span>Snooze for</span>
                    <input class="ui-field" type="number" min="0" step="any" required value={amount()} onInput={(e) => { setAmount(e.currentTarget.value); setError(null); }} />
                  </label>
                  <label class="snooze-field">
                    <span>Unit</span>
                    <select class="ui-field" value={unit()} onChange={(e) => { setUnit(e.currentTarget.value as SnoozeUnit); setError(null); }}>
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                    </select>
                  </label>
                </div>
              }
            >
              <div class="snooze-fields">
                <label class="snooze-field">
                  <span>Date</span>
                  <input class="ui-field" type="date" required autofocus value={date()} ref={(el) => queueMicrotask(() => el.focus())} onInput={(e) => { setDate(e.currentTarget.value); setError(null); }} />
                </label>
                <label class="snooze-field">
                  <span>Time</span>
                  <input class="ui-field" type="time" required value={time()} onInput={(e) => { setTime(e.currentTarget.value); setError(null); }} />
                </label>
              </div>
            </Show>

            <Show when={preview()}>{(when) => <p class="snooze-preview" style={{ margin: "0", "font-size": "11.5px", color: "var(--fg-subtle)" }}>Returns {when()}</p>}</Show>
            <Show when={error()}>{(message) => <p class="snooze-error" role="alert">{message()}</p>}</Show>
          </div>

          <footer class="snooze-foot">
            <button type="button" class="ui-btn ui-btn-ghost" onClick={close}>Cancel</button>
            <button type="submit" class="ui-btn ui-btn-solid" disabled={saving()}>{saving() ? "Snoozing…" : "Snooze"}</button>
          </footer>
        </form>
      </div>
    </Presence>
  );
};

export default SnoozeDialog;
