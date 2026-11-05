/** Custom snooze time math and the user's snooze presets, kept UI-free so they can be tested in Node. */
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

export type SnoozeUnit = "minutes" | "hours" | "days";

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` for a local date input. */
export const snoozeDateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `HH:MM` for a local time input. */
export const snoozeTimeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Resolve a date + time pair in the user's local time zone, or `null` when it is not in the future. */
export function resolveSnoozeDate(date: string, time: string, now = Date.now()): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})/.exec(time);
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) return null;
  const at = new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
  if (!Number.isFinite(at) || at <= now) return null;
  // Reject normalized dates such as Feb 31, which Date silently rolls forward.
  const back = new Date(at);
  if (back.getFullYear() !== year || back.getMonth() !== month - 1 || back.getDate() !== day) return null;
  return at;
}

/** Resolve a positive duration in the given unit, or `null`. Durations under a minute are refused. */
export function resolveSnoozeDuration(amount: string, unit: SnoozeUnit, now = Date.now()): number | null {
  const value = Number(amount.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = value * (unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000);
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  return now + ms;
}

// ── Snooze presets (Settings → Chat → Snooze options) ────────────────────────

/** One menu choice: a duration from now, or a local clock time on a day. `weekday` is
 *  JavaScript's `getDay()` (0 = Sunday) and only applies to `day: "weekday"`. */
export type SnoozeOption =
  | { kind: "after"; minutes: number }
  | { kind: "at"; day: "today" | "tomorrow" | "weekday"; weekday: number; time: string };

export const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" }, { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" }, { value: 5, label: "Friday" }, { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

export const DEFAULT_SNOOZE_OPTIONS: SnoozeOption[] = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "tomorrow", weekday: 1, time: "09:00" },
  { kind: "at", day: "weekday", weekday: 1, time: "09:00" },
];

export const MAX_SNOOZE_OPTIONS = 8;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validOption(option: unknown): option is SnoozeOption {
  if (!option || typeof option !== "object") return false;
  const value = option as Partial<SnoozeOption>;
  if (value.kind === "after") {
    return Number.isFinite(value.minutes) && (value.minutes ?? 0) >= 1 && (value.minutes ?? 0) <= 60 * 24 * 30;
  }
  if (value.kind === "at") {
    return ["today", "tomorrow", "weekday"].includes(value.day ?? "")
      && Number.isInteger(value.weekday) && (value.weekday ?? -1) >= 0 && (value.weekday ?? 7) <= 6
      && typeof value.time === "string" && TIME_RE.test(value.time);
  }
  return false;
}

const cloneOption = (option: SnoozeOption): SnoozeOption => ({ ...option });
const cloneOptions = (options: readonly SnoozeOption[]) => options.map(cloneOption);
const cleanOptions = (options: readonly SnoozeOption[]) =>
  options.filter(validOption).slice(0, MAX_SNOOZE_OPTIONS).map(cloneOption);

const KEY = "flipflopper:snooze-options";
const [optionsSignal, setOptionsSignal] = createSignal<SnoozeOption[]>(cloneOptions(DEFAULT_SNOOZE_OPTIONS));
/** The presets offered in the thread and selection snooze menus, soonest first. */
export const snoozeOptions = optionsSignal;

/** Save a new preset list; empty or invalid lists keep the previous value. */
export function setSnoozeOptions(options: readonly SnoozeOption[]) {
  const clean = cleanOptions(options);
  if (clean.length === 0) return;
  setOptionsSignal(clean);
  writePref(KEY, clean);
}

export function resetSnoozeOptions() {
  setSnoozeOptions(DEFAULT_SNOOZE_OPTIONS);
}

export async function hydrateSnoozeOptions() {
  const saved = await readPref<SnoozeOption[]>(KEY, DEFAULT_SNOOZE_OPTIONS).catch(() => DEFAULT_SNOOZE_OPTIONS);
  const clean = Array.isArray(saved) ? cleanOptions(saved) : [];
  setOptionsSignal(clean.length > 0 ? clean : cloneOptions(DEFAULT_SNOOZE_OPTIONS));
}

/** "30 minutes", "1 hour", "3 hours", "2 days", "1.5 hours". */
export function humanizeSnoozeMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) { const days = minutes / 1440; return `${days} day${days === 1 ? "" : "s"}`; }
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? "" : "s"}`;
}

/** When an option fires from `now`, or `null` when a "today" time has already passed. */
export function resolveSnoozeOption(option: SnoozeOption, now: number): number | null {
  if (option.kind === "after") return now + option.minutes * 60_000;
  const match = TIME_RE.exec(option.time);
  if (!match) return null;
  const at = new Date(now);
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (option.day === "today") return at.getTime() > now ? at.getTime() : null;
  if (option.day === "tomorrow") {
    at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  // "A weekday means the next one after today", so the same weekday is a week away.
  let ahead = (option.weekday - at.getDay() + 7) % 7;
  if (ahead === 0) ahead = 7;
  at.setDate(at.getDate() + ahead);
  return at.getTime();
}

/** A short name for a resolved option, e.g. "3 hours", "Tomorrow 9:00 AM", "Next Monday 9:00 AM". */
export function describeSnoozeOption(option: SnoozeOption, at: number): string {
  if (option.kind === "after") return humanizeSnoozeMinutes(option.minutes);
  const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = option.day === "today" ? "Today" : option.day === "tomorrow" ? "Tomorrow" : `Next ${WEEKDAY_OPTIONS.find((entry) => entry.value === option.weekday)?.label ?? "day"}`;
  return `${day} ${time}`;
}

/** The preset list resolved for `now`: past "today" choices are dropped and the rest sort soonest first. */
export function resolveSnoozeOptions(options: readonly SnoozeOption[], now: number): { label: string; until: number }[] {
  return options
    .flatMap((option) => {
      const until = resolveSnoozeOption(option, now);
      return until === null || until <= now ? [] : [{ label: describeSnoozeOption(option, until), until }];
    })
    .sort((a, b) => a.until - b.until);
}

/** Current presets for the menus. */
export function snoozePresets(now: Date = new Date()): { label: string; until: number }[] {
  return resolveSnoozeOptions(snoozeOptions(), now.getTime());
}
