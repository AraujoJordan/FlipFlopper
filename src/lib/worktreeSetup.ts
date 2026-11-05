// Worktree setup progress. The chat engine adds a card before the first turn
// and updates each setup script as it runs; the card lives above the transcript.
import { createSignal } from "solid-js";

export type WorktreeSetupStepStatus = "pending" | "running" | "done" | "failed";

export interface WorktreeSetupStep {
  id: string;
  name: string;
  command: string;
  status: WorktreeSetupStepStatus;
  output?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface WorktreeSetupState {
  id: string;
  projectPath: string;
  worktreePath: string;
  steps: WorktreeSetupStep[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

const [setups, setSetups] = createSignal<WorktreeSetupState[]>([]);
export const worktreeSetups = setups;

export function beginWorktreeSetup(
  projectPath: string,
  worktreePath: string,
  scripts: readonly { id: string; name: string; command: string }[],
): string {
  const id = `${worktreePath}:${Date.now()}`;
  const setup: WorktreeSetupState = {
    id,
    projectPath,
    worktreePath,
    steps: scripts.map((script) => ({ id: script.id, name: script.name, command: script.command, status: "pending" })),
    startedAt: Date.now(),
  };
  setSetups((list) => [...list.filter((entry) => entry.worktreePath !== worktreePath), setup].slice(-4));
  return id;
}

export function updateWorktreeSetupStep(id: string, index: number, patch: Partial<WorktreeSetupStep>) {
  setSetups((list) => list.map((setup) => setup.id === id
    ? { ...setup, steps: setup.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)) }
    : setup));
}

export function finishWorktreeSetup(id: string, error?: string) {
  setSetups((list) => list.map((setup) => setup.id === id ? { ...setup, finishedAt: Date.now(), error } : setup));
}

export function dismissWorktreeSetup(id: string) {
  setSetups((list) => list.filter((setup) => setup.id !== id));
}
