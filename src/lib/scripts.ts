// Named project scripts, T3-style project actions. Stored per checkout in
// preferences.json; running one opens a normal shell terminal so output,
// colors and the existing terminal controls all still work.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";
import { addTerminal, store } from "./store";
import { openTerminalDrawer } from "./layout";
import { openTerminal, ptySendLine } from "./ipc";
import { toast } from "../components/ui";

export interface ProjectScript { id: string; name: string; command: string; runOnWorktreeCreate?: boolean; runOnSettle?: boolean }

const KEY = "projectScripts";
const MAX_SCRIPTS = 30;
const [scripts, setScripts] = createSignal<Record<string, ProjectScript[]>>({});
export const projectScriptsByPath = scripts;

/** Scripts for one checkout, in the order they were added. */
export const projectScripts = (path: string | null | undefined): ProjectScript[] => (path ? scripts()[path] ?? [] : []);

export async function hydrateProjectScripts() {
  const saved = await readPref<Record<string, ProjectScript[]>>(KEY, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  const clean: Record<string, ProjectScript[]> = {};
  for (const [path, list] of Object.entries(saved)) {
    if (!Array.isArray(list)) continue;
    const valid = list
      .filter((entry): entry is ProjectScript => !!entry && typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.command === "string")
      .map((entry) => ({ id: entry.id, name: entry.name.slice(0, 80), command: entry.command.slice(0, 4000), runOnWorktreeCreate: entry.runOnWorktreeCreate === true, runOnSettle: entry.runOnSettle === true }))
      .filter((entry) => entry.name.trim() && entry.command.trim())
      .slice(0, MAX_SCRIPTS);
    if (valid.length) clean[path] = valid;
  }
  setScripts(clean);
}

const newId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function persist(next: Record<string, ProjectScript[]>) {
  setScripts(next);
  writePref(KEY, next);
}

/** Add a script; resolves to an error message, or `null` on success. */
export function addProjectScript(path: string, name: string, command: string): string | null {
  const cleanName = name.trim();
  const cleanCommand = command.trim();
  if (!path) return "Open a project first.";
  if (!cleanName) return "Give the script a name.";
  if (!cleanCommand) return "Enter a command.";
  const current = scripts()[path] ?? [];
  if (current.some((entry) => entry.name.toLowerCase() === cleanName.toLowerCase())) return "That name is already used in this project.";
  if (current.length >= MAX_SCRIPTS) return `Keep up to ${MAX_SCRIPTS} scripts per project.`;
  persist({ ...scripts(), [path]: [...current, { id: newId(), name: cleanName, command: cleanCommand }] });
  return null;
}

/** Rename or change a script in place. */
export function updateProjectScript(path: string, id: string, name: string, command: string): string | null {
  const cleanName = name.trim();
  const cleanCommand = command.trim();
  if (!cleanName) return "Give the script a name.";
  if (!cleanCommand) return "Enter a command.";
  const current = scripts()[path] ?? [];
  if (!current.some((entry) => entry.id === id)) return "That script no longer exists.";
  if (current.some((entry) => entry.id !== id && entry.name.toLowerCase() === cleanName.toLowerCase())) return "That name is already used in this project.";
  persist({ ...scripts(), [path]: current.map((entry) => entry.id === id ? { ...entry, name: cleanName, command: cleanCommand } : entry) });
  return null;
}

export function removeProjectScript(path: string, id: string) {  const current = scripts()[path] ?? [];
  const next = current.filter((entry) => entry.id !== id);
  const all = { ...scripts() };
  if (next.length) all[path] = next;
  else delete all[path];
  persist(all);
}

/** Mark a script as part of new-worktree setup. */
export function setProjectScriptWorktreeHook(path: string, id: string, enabled: boolean) {
  const current = scripts()[path] ?? [];
  persist({ ...scripts(), [path]: current.map((entry) => entry.id === id ? { ...entry, runOnWorktreeCreate: enabled } : entry) });
}

/** Mark a script to run when a worktree thread settles. */
export function setProjectScriptSettleHook(path: string, id: string, enabled: boolean) {
  const current = scripts()[path] ?? [];
  persist({ ...scripts(), [path]: current.map((entry) => entry.id === id ? { ...entry, runOnSettle: enabled } : entry) });
}

/** Run a script in a fresh terminal in the effective checkout. */
export async function runProjectScript(script: ProjectScript, projectPath?: string) {
  const project = projectPath ?? store.currentProject?.path;
  if (!project) { toast("Open a project first.", "info"); return; }
  try {
    const sessionId = await openTerminal(project, store.activeCwd ?? project);
    addTerminal({ sessionId, label: script.name, kind: "shell" });
    openTerminalDrawer();
    await ptySendLine(sessionId, script.command);
  } catch (error) {
    toast(`Couldn't run ${script.name}: ${String(error)}`, "error");
  }
}

/** Run a one-off shell command from a Markdown code block in a fresh terminal. */
export async function runTerminalCommand(command: string, label = "Command") {
  const project = store.currentProject?.path ?? store.activeCwd;
  if (!project) { toast("Open a project first.", "info"); return; }
  const text = command.trim();
  if (!text) { toast("This code block is empty.", "info"); return; }
  try {
    const sessionId = await openTerminal(project, store.activeCwd ?? project);
    addTerminal({ sessionId, label, kind: "shell" });
    openTerminalDrawer();
    await ptySendLine(sessionId, text);
  } catch (error) {
    toast(`Couldn't run this command: ${String(error)}`, "error");
  }
}
