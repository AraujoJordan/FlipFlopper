// Scheduled prompts: recurring prompts delivered into a session (or a new one in a
// project) while the app is open. Missed runs fire once on launch; they are never
// replayed per occurrence. Persisted in preferences.json.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { chat, enqueueFollowUp, isRunning, sendPromptTo, startSessionTurn } from "./chat";
import { readPref, writePref } from "./appPrefs";
import { toast } from "../components/ui";

export type ScheduleRule =
  | { kind: "every"; minutes: number }
  | { kind: "daily"; time: string; weekdays?: number[] }
  | { kind: "once"; at: number };

export type ScheduleTarget = { session_id: string } | { project_path: string; agent_id: string };

export interface ScheduleRun { at: number; session_id?: string; ok: boolean; error?: string }

export interface Schedule {
  id: string;
  name: string;
  target: ScheduleTarget;
  prompt: string;
  rule: ScheduleRule;
  paused: boolean;
  /** A one-time schedule that has been delivered. */
  ended?: boolean;
  /** Newest first, at most `MAX_RUNS`. */
  runs: ScheduleRun[];
  last_run?: number;
  next_run: number;
}

const MAX_RUNS = 20;
const MIN_EVERY_MINUTES = 5;
const nameOf = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};

const KEY = "schedules";
const WEEKDAYS = [1, 2, 3, 4, 5];

/** Next fire time strictly after `from`. */
export function nextRun(rule: ScheduleRule, from: Date): number {
  if (rule.kind === "once") return rule.at;
  if (rule.kind === "every") return from.getTime() + Math.max(1, rule.minutes) * 60_000;
  const [h, m] = rule.time.split(":").map(Number);
  const days = rule.weekdays?.length ? rule.weekdays : [0, 1, 2, 3, 4, 5, 6];
  const candidate = new Date(from);
  candidate.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (candidate.getTime() > from.getTime() && days.includes(candidate.getDay())) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(h, m, 0, 0);
  }
  return from.getTime() + 24 * 3_600_000;
}

/** `[new] every 30m|2h <prompt>` · `[new] daily|weekdays|once 09:00 <prompt>` · `[new] in 2h|30m <prompt>`.
 *  `new` starts a fresh session on every run instead of delivering into the current one. */
export function parseScheduleSpec(text: string, now: Date = new Date()): { rule: ScheduleRule; prompt: string; newSession: boolean } | string {
  const usage = "Usage: /schedule [new] every 30m <prompt> · daily 09:00 · weekdays 09:00 · once 14:30 · in 2h";
  let rest = text.trim();
  const newSession = /^new\s+/i.test(rest);
  if (newSession) rest = rest.replace(/^new\s+/i, "");
  const m = /^(every|daily|weekdays|once|in)\s+(\S+)\s+([\s\S]+)$/i.exec(rest);
  if (!m) return usage;
  const [, rawKind, when, rawPrompt] = m;
  const kind = rawKind.toLowerCase();
  const prompt = rawPrompt.trim();
  if (kind === "every" || kind === "in") {
    const d = /^(\d+)([mh])$/i.exec(when);
    const minutes = d ? Number(d[1]) * (d[2].toLowerCase() === "h" ? 60 : 1) : 0;
    if (!minutes) return "Use an interval like 30m or 2h.";
    if (kind === "in") return { rule: { kind: "once", at: now.getTime() + minutes * 60_000 }, prompt, newSession };
    if (minutes < MIN_EVERY_MINUTES) return `Minimum interval is ${MIN_EVERY_MINUTES} minutes.`;
    return { rule: { kind: "every", minutes }, prompt, newSession };
  }
  const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(when);
  if (!t) return "Use a 24-hour time like 09:00.";
  const time = `${t[1].padStart(2, "0")}:${t[2]}`;
  if (kind === "once") return { rule: { kind: "once", at: nextRun({ kind: "daily", time }, now) }, prompt, newSession };
  return { rule: { kind: "daily", time, ...(kind === "weekdays" ? { weekdays: WEEKDAYS } : {}) }, prompt, newSession };
}

export const describeRule = (rule: ScheduleRule): string =>
  rule.kind === "once"
    ? `once, ${new Date(rule.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : rule.kind === "every"
      ? `every ${rule.minutes % 60 === 0 ? `${rule.minutes / 60}h` : `${rule.minutes}m`}`
      : `${rule.weekdays?.length === 5 ? "weekdays" : "daily"} at ${rule.time}`;

/** Sessions that currently receive scheduled prompts (for the sidebar clock mark). */
export const scheduledSessionIds = (list: readonly Schedule[] = schedules): Set<string> =>
  new Set(list.flatMap((s) => (!s.paused && !s.ended && "session_id" in s.target ? [s.target.session_id] : [])));

export const [schedules, setSchedules] = createStore<Schedule[]>([]);
export const [schedulesOpen, setSchedulesOpen] = createSignal(false);
let hydrated = false;
const persist = () => { if (hydrated) writePref(KEY, JSON.parse(JSON.stringify(schedules))); };

export async function hydrateSchedules() {
  const saved = await readPref<Schedule[]>(KEY, []);
  // Schedules saved by older builds lack a name and run history.
  setSchedules(Array.isArray(saved) ? saved.map((s) => ({ ...s, name: s.name ?? nameOf(s.prompt), runs: s.runs ?? [] })) : []);
  hydrated = true;
}

/** Where a new schedule is created from: the open session (if any), its project and the composer's agent. */
export interface ScheduleContext { session_id?: string | null; project_path?: string | null; agent_id: string }

export function addSchedule(ctx: ScheduleContext, spec: string, now: Date = new Date()): string | null {
  const parsed = parseScheduleSpec(spec, now);
  if (typeof parsed === "string") return parsed;
  const target: ScheduleTarget | null = !parsed.newSession && ctx.session_id
    ? { session_id: ctx.session_id }
    : ctx.project_path ? { project_path: ctx.project_path, agent_id: ctx.agent_id } : null;
  if (!target) return "Choose a project or open a session first.";
  const entry: Schedule = {
    id: crypto.randomUUID(), name: nameOf(parsed.prompt), target, prompt: parsed.prompt, rule: parsed.rule,
    paused: false, runs: [], next_run: nextRun(parsed.rule, now),
  };
  setSchedules((all) => [...all, entry]);
  persist();
  return null;
}

/** One-shot schedule for an explicit timestamp, used for usage-limit recovery. */
export function addScheduleAt(ctx: ScheduleContext, prompt: string, at: number, name: string): string | null {
  const target: ScheduleTarget | null = ctx.session_id
    ? { session_id: ctx.session_id }
    : ctx.project_path ? { project_path: ctx.project_path, agent_id: ctx.agent_id } : null;
  if (!target) return "Open a session or project first.";
  if (at <= Date.now()) return "The reset time has already passed.";
  const entry: Schedule = {
    id: crypto.randomUUID(), name, target, prompt, rule: { kind: "once", at },
    paused: false, runs: [], next_run: at,
  };
  setSchedules((all) => [...all, entry]);
  persist();
  return null;
}

export function toggleSchedule(id: string) {
  setSchedules((s) => s.id === id && !s.ended, produce((s) => { s.paused = !s.paused; if (!s.paused && s.rule.kind !== "once") s.next_run = nextRun(s.rule, new Date()); }));
  persist();
}

/** Edit an existing schedule's text, rule or destination. */
export function updateSchedule(
  id: string,
  patch: Partial<Pick<Schedule, "name" | "prompt" | "rule" | "target" | "paused">>,
  now: Date = new Date(),
) {
  setSchedules((s) => s.id === id, produce((s) => {
    Object.assign(s, patch);
    if (patch.rule) {
      s.next_run = nextRun(patch.rule, now);
      s.ended = false;
      s.last_run = undefined;
    }
  }));
  persist();
}
export function deleteSchedule(id: string) {
  setSchedules((all) => all.filter((s) => s.id !== id));
  persist();
}

const timeLabel = (d: Date) => d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function recordRun(id: string, run: ScheduleRun) {
  setSchedules((x) => x.id === id, produce((x) => { x.runs = [run, ...x.runs].slice(0, MAX_RUNS); }));
  persist();
}

export async function runSchedule(s: Schedule): Promise<void> {
  const now = new Date();
  const once = s.rule.kind === "once";
  // Advance first so a slow delivery cannot fire twice; a one-time schedule ends here.
  setSchedules((x) => x.id === s.id, once ? { last_run: now.getTime(), ended: true } : { last_run: now.getTime(), next_run: nextRun(s.rule, now) });
  persist();
  try {
    if ("session_id" in s.target) {
      const id = s.target.session_id;
      if (!chat.sessions.some((x) => x.id === id)) {
        setSchedules((x) => x.id === s.id, { paused: true });
        recordRun(s.id, { at: now.getTime(), ok: false, error: "The session no longer exists" });
        toast("A scheduled prompt was paused: its session no longer exists.", "error");
        return;
      }
      if (isRunning(id)) enqueueFollowUp(id, s.prompt);
      else if (!(await sendPromptTo(id, s.prompt))) throw new Error("The prompt could not be sent");
      recordRun(s.id, { at: now.getTime(), session_id: id, ok: true });
    } else {
      const c = chat.composer;
      const meta = await startSessionTurn({
        projectPath: s.target.project_path, agentId: s.target.agent_id, mode: c.mode, yolo: c.yolo,
        prompt: s.prompt, title: `${s.name} · ${timeLabel(now)}`,
      });
      recordRun(s.id, { at: now.getTime(), session_id: meta.id, ok: true });
    }
  } catch (error) {
    recordRun(s.id, { at: now.getTime(), ok: false, error: String(error) });
    toast(`Scheduled prompt failed: ${String(error)}`, "error");
  }
}

/** Fire everything that is due; called on an interval and once at startup. */
export function runDueSchedules(at = Date.now()) {
  if (!hydrated || !chat.ready) return; // sessions must be loaded before targets are checked
  for (const s of schedules.filter((x) => !x.paused && !x.ended && x.next_run <= at)) void runSchedule({ ...s });
}
