import { createStore } from "solid-js/store";
import type { AgentInfo, ProjectInfo } from "./ipc";
import { getCurrentBranch, ptyKill } from "./ipc";
import { openSide } from "./layout";
import { disposeCachedTerminal } from "./terminalCache";
import { readLegacyJson, readPref, writePref } from "./appPrefs";

// App-level state that is not part of a chat session: the open project, the
// agent registry, the terminal list, git refresh counters and the diff review
// target. Sessions and transcripts live in `lib/chat.ts`; layout in
// `lib/layout.ts`.

export type TerminalKind = "run" | "validate" | "install" | "shell";

export interface TerminalTab {
  sessionId: string;
  label: string;
  kind: TerminalKind;
}

export interface WorktreeInfoRef {
  path: string;
  branch: string;
  sourceBranch: string;
}

export interface ReviewState {
  /** git revision range (e.g. "sha~1..sha") or undefined for working-tree */
  rev: string | undefined;
  /** file path relative to project root, or undefined for whole-tree */
  path: string | undefined;
  title: string;
  /** "staged" | "unstaged" scopes the diff to the index or worktree only;
   *  omitted means the default working-tree-vs-HEAD (or commit range) view */
  mode?: "staged" | "unstaged";
}

export interface AppStore {
  currentProject: ProjectInfo | null;
  recentProjects: ProjectInfo[];
  agents: AgentInfo[];
  /** Directory the active chat session runs in (project root or worktree);
   *  drives `effectiveRoot()` for git, run and terminal features. */
  activeCwd: string | null;
  activeSessionWorktree: WorktreeInfoRef | undefined;
  review: ReviewState | null;
  runSessionId: string | null;
  validationSessionId: string | null;
  /** bumped after agent turns/commits so git-status consumers refetch */
  gitStatusVersion: number;
  currentBranch: string;
  gitPanelTab: "changes" | "history";
  /** project-relative path to scope the History tab log to, or null for repo-wide */
  historyFilterPath: string | null;
  /** One-shot channel: external components seed the composer with a
   *  ready-made instruction. The composer appends/focuses it as editable text
   *  and clears this. */
  pendingPromptSeed: { text: string; projectPath?: string } | null;
  /** True from launch until the persisted workspace has been restored or
   *  determined absent; drives skeleton states. */
  restoringWorkspace: boolean;
  terminals: TerminalTab[];
  activeTerminalId: string | null;
}

const initial: AppStore = {
  currentProject: null,
  recentProjects: [],
  agents: [],
  activeCwd: null,
  activeSessionWorktree: undefined,
  review: null,
  runSessionId: null,
  validationSessionId: null,
  gitStatusVersion: 0,
  currentBranch: "",
  gitPanelTab: "changes",
  historyFilterPath: null,
  pendingPromptSeed: null,
  restoringWorkspace: true,
  terminals: [],
  activeTerminalId: null,
};

export const [store, setStore] = createStore<AppStore>(initial);

// ── Checkout resolution ──────────────────────────────────────────────────────

export function activeWorktree(): WorktreeInfoRef | undefined {
  return store.activeSessionWorktree;
}

/** The directory git/run/terminal features operate on: the active session's
 *  cwd (its worktree, if any), else the open project. */
export function effectiveRoot(): string | null {
  return store.activeCwd ?? store.currentProject?.path ?? null;
}

// ── Per-project remembered choices ───────────────────────────────────────────

const RUN_TARGET_KEY = "flipflopper:run-targets";
const VALIDATION_TARGET_KEY = "flipflopper:validation-targets";
const ANDROID_DEVICE_KEY = "flipflopper:android-devices";

const runTargetsCache = readLegacyJson<Record<string, string>>(RUN_TARGET_KEY, {});
const validationTargetsCache = readLegacyJson<Record<string, string>>(VALIDATION_TARGET_KEY, {});
const androidDevicesCache = readLegacyJson<Record<string, string>>(ANDROID_DEVICE_KEY, {});

export function readRunTargets(): Record<string, string> {
  return runTargetsCache;
}

export function writeRunTarget(projectPath: string, targetId: string) {
  runTargetsCache[projectPath] = targetId;
  writePref(RUN_TARGET_KEY, runTargetsCache);
}

export function readValidationTargets(): Record<string, string> {
  return validationTargetsCache;
}

export function writeValidationTarget(projectPath: string, targetId: string) {
  validationTargetsCache[projectPath] = targetId;
  writePref(VALIDATION_TARGET_KEY, validationTargetsCache);
}

export function readAndroidDevices(): Record<string, string> {
  return androidDevicesCache;
}

export function writeAndroidDevice(projectPath: string, serial: string) {
  androidDevicesCache[projectPath] = serial;
  writePref(ANDROID_DEVICE_KEY, androidDevicesCache);
}

/** Load durable copies of the caches above (they are seeded synchronously from
 *  legacy localStorage so the first paint doesn't wait on the pref store). */
export async function hydrateStorePreferences() {
  const [runTargets, validationTargets, androidDevices] = await Promise.all([
    readPref(RUN_TARGET_KEY, runTargetsCache, () => runTargetsCache),
    readPref(VALIDATION_TARGET_KEY, validationTargetsCache, () => validationTargetsCache),
    readPref(ANDROID_DEVICE_KEY, androidDevicesCache, () => androidDevicesCache),
  ]);
  Object.assign(runTargetsCache, runTargets);
  Object.assign(validationTargetsCache, validationTargets);
  Object.assign(androidDevicesCache, androidDevices);
}

// ── Terminal helpers ─────────────────────────────────────────────────────────

export function addTerminal(tab: TerminalTab) {
  setStore("terminals", (t) => [...t, tab]);
  setStore("activeTerminalId", tab.sessionId);
  openSide("terminal");
}

export function setActiveTerminal(sessionId: string) {
  setStore("activeTerminalId", sessionId);
}

export function removeTerminal(sessionId: string) {
  ptyKill(sessionId).catch(() => { /* already exited */ });
  disposeCachedTerminal(sessionId);
  setStore("terminals", (t) => t.filter((x) => x.sessionId !== sessionId));
  setStore("activeTerminalId", (cur) => {
    if (cur !== sessionId) return cur;
    const remaining = store.terminals.filter((x) => x.sessionId !== sessionId);
    return remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
  });
  if (store.runSessionId === sessionId) setStore("runSessionId", null);
  if (store.validationSessionId === sessionId) setStore("validationSessionId", null);
}

// Run and validation sessions are each written from more than one component,
// so they go through these mutators rather than raw `setStore` calls.

export function setRunSessionId(sessionId: string | null) {
  setStore("runSessionId", sessionId);
}

export function setValidationSessionId(sessionId: string | null) {
  setStore("validationSessionId", sessionId);
}

// ── Diff review ──────────────────────────────────────────────────────────────

/** Open the diff view in the side pane for the given revision range (or the
 *  working tree if `rev` is undefined), optionally scoped to one file. The
 *  diff is computed on demand by the backend. */
export function openReview(
  rev: string | undefined,
  title: string,
  path?: string,
  mode?: "staged" | "unstaged",
) {
  if (!store.currentProject) return;
  setStore("review", { rev, path, title, mode });
  openSide("changes");
}

export function closeReview() {
  setStore("review", null);
}

// ── Git panel state ──────────────────────────────────────────────────────────

export function setGitPanelTab(tab: "changes" | "history") {
  setStore("gitPanelTab", tab);
}

export function clearHistoryFilter() {
  setStore("historyFilterPath", null);
}

/** Seed the composer with a ready-made instruction. */
export function setPendingPromptSeed(seed: { text: string; projectPath?: string } | null) {
  setStore("pendingPromptSeed", seed);
}

/** Nudge git-status consumers to refetch. */
export function bumpGitStatus() {
  setStore("gitStatusVersion", (v) => v + 1);
}

/** Fetch the current git branch and update the store. Empty string means
 *  "no project" or "couldn't determine" — never a lie about being on main. */
export async function updateCurrentBranch() {
  const projectPath = effectiveRoot();
  if (!projectPath) {
    setStore("currentBranch", "");
    return;
  }
  try {
    const branchName = await getCurrentBranch(projectPath);
    setStore("currentBranch", branchName || "");
  } catch {
    setStore("currentBranch", "");
  }
}
