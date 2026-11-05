// Session goals: one durable objective per session. After each finished turn the
// app queues a continuation until the agent reports GOAL COMPLETE / GOAL BLOCKED,
// the round limit is hit, or the turn fails. Works for every agent.
import { chat, setChat, enqueueFollowUp, submitPrompt } from "./chat";
import { chatUpdateSession, type Goal } from "./ipc";
import { lastAssistant } from "./transcript";
import { toast } from "../components/ui";

export const DEFAULT_MAX_ROUNDS = 5;

export type GoalSignal = { kind: "complete" } | { kind: "blocked"; reason: string } | null;

const INSTRUCTIONS =
  "When the goal is fully achieved, end your reply with a line that says exactly `GOAL COMPLETE`. " +
  "If you cannot make further progress without the user, end with a line `GOAL BLOCKED: <reason>`.";

/** Look for the sentinel lines in the assistant's reply (line-anchored, last one wins). */
export function parseGoalSignal(text: string): GoalSignal {
  let signal: GoalSignal = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[`*_>\s-]+|[`*_\s]+$/g, "");
    if (/^GOAL COMPLETE\.?$/.test(line)) signal = { kind: "complete" };
    else {
      const blocked = /^GOAL BLOCKED:\s*(.*)$/.exec(line);
      if (blocked) signal = { kind: "blocked", reason: blocked[1].trim() || "No reason given" };
    }
  }
  return signal;
}

export function goalPrompt(goal: Pick<Goal, "text" | "rounds" | "max_rounds">, first: boolean): string {
  return first
    ? `Goal: ${goal.text}\n\nWork on this until it is done; I will keep prompting you to continue. ${INSTRUCTIONS}`
    : `Continue working toward the goal: ${goal.text}\n\n(Turn ${goal.rounds + 1} of ${goal.max_rounds}.) ${INSTRUCTIONS}`;
}

/** Everything the assistant wrote as text in its last message. */
export function lastReplyText(view: Parameters<typeof lastAssistant>[0] | undefined): string {
  const message = view ? lastAssistant(view) : undefined;
  return message ? message.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n") : "";
}

export function sessionGoal(id: string | null | undefined): Goal | null {
  return (id && chat.sessions.find((s) => s.id === id)?.goal) || null;
}

/** Update the store synchronously (so the turn-end queue sees it), then persist. */
export function applyGoal(id: string, goal: Goal | null) {
  setChat("sessions", (s) => s.id === id, "goal", goal);
  void chatUpdateSession(id, { goal }).catch((error) => toast(`Couldn't save goal: ${String(error)}`, "error"));
}

export async function startGoal(text: string, id: string | null = chat.activeId): Promise<boolean> {
  const goal: Goal = { text: text.trim(), status: "active", rounds: 0, max_rounds: DEFAULT_MAX_ROUNDS, note: null };
  if (!goal.text) return false;
  if (id) {
    applyGoal(id, goal);
    return submitPrompt(goalPrompt(goal, true));
  }
  return submitPrompt(goalPrompt(goal, true), [], (newId) => applyGoal(newId, goal));
}

const patchGoal = (id: string, change: Partial<Goal>) => {
  const goal = sessionGoal(id);
  if (goal) applyGoal(id, { ...goal, ...change });
};
export const pauseGoal = (id: string) => patchGoal(id, { status: "paused" });
export const resumeGoal = (id: string) => patchGoal(id, { status: "active", note: null, rounds: 0 });
export const clearGoal = (id: string) => { if (sessionGoal(id)) applyGoal(id, null); };

/** Turn-end driver. Must stay synchronous: the chat queue is read right after handlers run. */
export function onGoalTurnEnd(id: string, status: string) {
  const goal = sessionGoal(id);
  if (!goal || goal.status !== "active") return;
  if (status !== "done") {
    patchGoal(id, { status: "paused", note: status === "cancelled" ? "Stopped" : "Turn failed" });
    return;
  }
  if (chat.queued[id]?.length) return; // the user's own follow-ups go first
  const signal = parseGoalSignal(lastReplyText(chat.views[id]));
  if (signal?.kind === "complete") {
    patchGoal(id, { status: "done", note: null });
    toast("Goal complete", "info");
  } else if (signal?.kind === "blocked") {
    patchGoal(id, { status: "blocked", note: signal.reason });
    toast(`Goal blocked: ${signal.reason}`, "info");
  } else if (goal.rounds + 1 >= goal.max_rounds) {
    patchGoal(id, { status: "paused", rounds: goal.rounds + 1, note: "Round limit reached" });
    toast("Goal paused: round limit reached", "info");
  } else {
    const next = { ...goal, rounds: goal.rounds + 1 };
    applyGoal(id, next);
    enqueueFollowUp(id, goalPrompt(next, false));
  }
}
