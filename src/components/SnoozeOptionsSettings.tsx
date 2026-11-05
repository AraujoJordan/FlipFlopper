import { Component, For, Show } from "solid-js";
import { Icon } from "./shell/Icon";
import {
  MAX_SNOOZE_OPTIONS, WEEKDAY_OPTIONS, resetSnoozeOptions, setSnoozeOptions, snoozeOptions,
  type SnoozeOption, type SnoozeUnit,
} from "../lib/snooze";

const UNITS: { id: SnoozeUnit; minutes: number; label: string }[] = [
  { id: "minutes", minutes: 1, label: "minutes" },
  { id: "hours", minutes: 60, label: "hours" },
  { id: "days", minutes: 1440, label: "days" },
];

/** The unit that shows a duration without fractions. */
function unitFor(minutes: number): SnoozeUnit {
  if (minutes % 1440 === 0) return "days";
  if (minutes % 60 === 0) return "hours";
  return "minutes";
}
const amountFor = (minutes: number, unit: SnoozeUnit) =>
  Math.max(1, Math.round((minutes / (UNITS.find((entry) => entry.id === unit)?.minutes ?? 1)) * 100) / 100);

/** Settings → Chat → Snooze options: the choices the snooze menus offer. */
const SnoozeOptionsSettings: Component = () => {
  const options = () => snoozeOptions();
  const replace = (index: number, next: SnoozeOption) =>
    setSnoozeOptions(options().map((option, at) => (at === index ? next : option)));
  const remove = (index: number) => setSnoozeOptions(options().filter((_, at) => at !== index));
  const add = () => { if (options().length < MAX_SNOOZE_OPTIONS) setSnoozeOptions([...options(), { kind: "after", minutes: 60 }]); };

  return (
    <div class="snooze-options">
      <For each={options()}>
        {(option, index) => {
          const minutes = () => (option.kind === "after" ? option.minutes : 60);
          const day = () => (option.kind === "at" ? option.day : "tomorrow");
          const weekday = () => (option.kind === "at" ? option.weekday : 1);
          const time = () => (option.kind === "at" ? option.time : "09:00");
          const setAfter = (next: number) => replace(index(), { kind: "after", minutes: Math.min(60 * 24 * 30, Math.max(1, Math.round(next))) });
          const setAt = (patch: { day?: "today" | "tomorrow" | "weekday"; weekday?: number; time?: string }) => {
            const nextTime = patch.time ?? time();
            // A time picker briefly reports an empty value while it is edited; keep the last valid one.
            if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(nextTime)) return;
            replace(index(), { kind: "at", day: patch.day ?? day(), weekday: patch.weekday ?? weekday(), time: nextTime });
          };
          const unit = () => unitFor(minutes());
          return (
            <div class="snooze-option">
              <div class="seg snooze-option-kind" role="group" aria-label={`Snooze option ${index() + 1} type`}>
                <button type="button" class="seg-btn" aria-pressed={option.kind === "after"} classList={{ "seg-on": option.kind === "after" }} onClick={() => replace(index(), { kind: "after", minutes: minutes() })}>After</button>
                <button type="button" class="seg-btn" aria-pressed={option.kind === "at"} classList={{ "seg-on": option.kind === "at" }} onClick={() => replace(index(), { kind: "at", day: day(), weekday: weekday(), time: time() })}>At</button>
              </div>
              <Show
                when={option.kind === "after"}
                fallback={
                  <>
                    <select class="ui-field snooze-option-field" aria-label={`Snooze option ${index() + 1} day`} value={day()} onChange={(event) => setAt({ day: event.currentTarget.value as "today" | "tomorrow" | "weekday" })}>
                      <option value="today">Today</option>
                      <option value="tomorrow">Tomorrow</option>
                      <option value="weekday">Weekday</option>
                    </select>
                    <Show when={day() === "weekday"}>
                      <select class="ui-field snooze-option-field" aria-label={`Snooze option ${index() + 1} weekday`} value={String(weekday())} onChange={(event) => setAt({ weekday: Number(event.currentTarget.value) })}>
                        <For each={WEEKDAY_OPTIONS}>{(entry) => <option value={String(entry.value)}>{entry.label}</option>}</For>
                      </select>
                    </Show>
                    <input class="ui-field snooze-option-field" type="time" aria-label={`Snooze option ${index() + 1} time`} value={time()} onInput={(event) => setAt({ time: event.currentTarget.value })} />
                  </>
                }
              >
                <input class="ui-field snooze-option-field snooze-option-amount" type="number" min="1" step="any" aria-label={`Snooze option ${index() + 1} amount`}
                  value={amountFor(minutes(), unit())}
                  onChange={(event) => setAfter(Number(event.currentTarget.value) * (UNITS.find((entry) => entry.id === unit())?.minutes ?? 1))} />
                <select class="ui-field snooze-option-field" aria-label={`Snooze option ${index() + 1} unit`} value={unit()}
                  onChange={(event) => { const next = UNITS.find((entry) => entry.id === event.currentTarget.value)!; setAfter(amountFor(minutes(), unit()) * next.minutes); }}>
                  <For each={UNITS}>{(entry) => <option value={entry.id}>{entry.label}</option>}</For>
                </select>
              </Show>
              <button type="button" class="icon-btn" title="Remove this option" aria-label={`Remove snooze option ${index() + 1}`} disabled={options().length <= 1} onClick={() => remove(index())}>
                <Icon name="x" size={13} />
              </button>
            </div>
          );
        }}
      </For>
      <div class="snooze-options-footer">
        <button type="button" class="ui-btn ui-btn-outline settings-btn" disabled={options().length >= MAX_SNOOZE_OPTIONS} onClick={add}>
          <Icon name="plus" size={13} /> Add option
        </button>
        <button type="button" class="ui-btn ui-btn-ghost settings-btn" onClick={() => resetSnoozeOptions()}>Reset defaults</button>
        <span class="settings-row-hint">{options().length} of {MAX_SNOOZE_OPTIONS} options. Menus list the soonest first and hide a “Today” time once it has passed.</span>
      </div>
    </div>
  );
};

export default SnoozeOptionsSettings;
