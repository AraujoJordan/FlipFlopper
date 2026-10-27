import { createStore } from "solid-js/store";
import type { AgentInfo, ProjectInfo, RunTarget } from "./ipc";
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

export interface ReviewCommentDraft {
  id: string;
  filePath: string;
  lineRangeLabel: string;
  fenceLang: string;
  snippet: string;
  instruction: string;
  endFlatIndex: number;
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
  /** Run targets of the open project, shared by RunButton and the Preview tab. */
  runTargets: RunTarget[];
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
  /** Keyed by `${root}::${revScope}::${path}` → diff/status signature or `"*"`. */
  viewedFiles: Record<string, string>;
  /** Queued inline review comments across files/lines before batch submission. */
  reviewComments: ReviewCommentDraft[];
  /** True from launch until the persisted workspace has been restored or
   *  determined absent; drives skeleton states. */
  restoringWorkspace: boolean;
  terminals: TerminalTab[];
  activeTerminalId: string | null;
}

const VIEWED_FILES_KEY = "flipflopper:viewed-files";
const viewedFilesCache = readLegacyJson<Record<string, string>>(VIEWED_FILES_KEY, {});

const initial: AppStore = {
  currentProject: null,
  recentProjects: [],
  agents: [],
  activeCwd: null,
  activeSessionWorktree: undefined,
  review: null,
  runSessionId: null,
  runTargets: [],
  validationSessionId: null,
  gitStatusVersion: 0,
  currentBranch: "",
  gitPanelTab: "changes",
  historyFilterPath: null,
  pendingPromptSeed: null,
  viewedFiles: { ...viewedFilesCache },
  reviewComments: [],
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

function projectStringPreferences(key: string) {
  // Seed synchronously from legacy localStorage so the first paint doesn't wait
  // on the pref store, then hydrate this same object with its durable values.
  const cache = readLegacyJson<Record<string, string>>(key, {});
  return {
    read: () => cache,
    write(projectPath: string, value: string) {
      cache[projectPath] = value;
      writePref(key, cache);
    },
    async hydrate() {
      Object.assign(cache, await readPref(key, cache, () => cache));
    },
  };
}

const runTargetPrefs = projectStringPreferences("flipflopper:run-targets");
const validationTargetPrefs = projectStringPreferences("flipflopper:validation-targets");
const androidDevicePrefs = projectStringPreferences("flipflopper:android-devices");
const iosSimulatorPrefs = projectStringPreferences("flipflopper:ios-simulators");

export const readRunTargets = runTargetPrefs.read;
export const writeRunTarget = runTargetPrefs.write;
export const readValidationTargets = validationTargetPrefs.read;
export const writeValidationTarget = validationTargetPrefs.write;
export const readAndroidDevices = androidDevicePrefs.read;
export const writeAndroidDevice = androidDevicePrefs.write;
export const readIosSimulators = iosSimulatorPrefs.read;
/** The iOS device (simulator udid) Run and the Preview tab share per project. */
export const writeIosSimulator = iosSimulatorPrefs.write;

/** Load durable copies of the project preferences and viewed-file state. */
export async function hydrateStorePreferences() {
  const [, , , , viewedFiles] = await Promise.all([
    runTargetPrefs.hydrate(),
    validationTargetPrefs.hydrate(),
    androidDevicePrefs.hydrate(),
    iosSimulatorPrefs.hydrate(),
    readPref(VIEWED_FILES_KEY, viewedFilesCache, () => viewedFilesCache),
  ]);
  Object.assign(viewedFilesCache, viewedFiles);
  setStore("viewedFiles", { ...viewedFilesCache });
}

// ── Terminal helpers ─────────────────────────────────────────────────────────

export function setRunTargets(targets: RunTarget[]) {
  setStore("runTargets", targets);
}

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

const MAX_VIEWED_ENTRIES = 600;

function viewedKey(path: string, rev?: string): string | null {
  const root = effectiveRoot();
  if (!root) return null;
  return `${root}::${rev ?? "worktree"}::${path}`;
}

export function fileDiffSignature(file: {
  status: string;
  additions: number;
  deletions: number;
  hunks: { header: string; lines: { kind: string; content: string }[] }[];
}): string {
  let hash = 2166136261;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  };
  feed(`${file.status}:${file.additions}:${file.deletions}`);
  for (const h of file.hunks) {
    feed(h.header);
    for (const l of h.lines) {
      feed(`${l.kind[0]}:${l.content}\n`);
    }
  }
  return (hash >>> 0).toString(36);
}

export function isFileViewed(path: string, rev?: string, diffSig?: string): boolean {
  const key = viewedKey(path, rev);
  if (!key) return false;
  const saved = store.viewedFiles[key];
  if (!saved) return false;
  if (!diffSig || saved === "*") return true;
  return saved === diffSig;
}

export function setFileViewed(path: string, viewed: boolean, rev?: string, diffSig?: string) {
  const key = viewedKey(path, rev);
  if (!key) return;
  if (viewed) {
    const val = diffSig ?? "*";
    viewedFilesCache[key] = val;
    const keys = Object.keys(viewedFilesCache);
    if (keys.length > MAX_VIEWED_ENTRIES) {
      for (const oldKey of keys.slice(0, keys.length - MAX_VIEWED_ENTRIES)) {
        delete viewedFilesCache[oldKey];
      }
    }
    setStore("viewedFiles", key, val);
  } else {
    delete viewedFilesCache[key];
    setStore("viewedFiles", key, undefined!);
  }
  writePref(VIEWED_FILES_KEY, viewedFilesCache);
}

export function addReviewComment(draft: Omit<ReviewCommentDraft, "id">): ReviewCommentDraft {
  const item: ReviewCommentDraft = {
    ...draft,
    id: `rc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  };
  setStore("reviewComments", (list) => [...list, item]);
  return item;
}

export function removeReviewComment(id: string) {
  setStore("reviewComments", (list) => list.filter((c) => c.id !== id));
}

export function clearReviewComments() {
  setStore("reviewComments", []);
}

export function formatReviewBatchPrompt(comments = store.reviewComments): string {
  if (comments.length === 0) return "";
  if (comments.length === 1) {
    const c = comments[0];
    return `In \`@${c.filePath}\`${c.lineRangeLabel ? ` (${c.lineRangeLabel})` : ""}:\n\`\`\`${c.fenceLang}\n${c.snippet}\n\`\`\`\n${c.instruction}`;
  }
  const sections = comments.map(
    (c, idx) =>
      `### ${idx + 1}. \`@${c.filePath}\`${c.lineRangeLabel ? ` (${c.lineRangeLabel})` : ""}\n\`\`\`${c.fenceLang}\n${c.snippet}\n\`\`\`\n${c.instruction}`,
  );
  return `Please address the following ${comments.length} code review comments:\n\n${sections.join("\n\n")}`;
}

// ── Git panel state ──────────────────────────────────────────────────────────

export function setGitPanelTab(tab: "changes" | "history") {
  setStore("gitPanelTab", tab);
}

export function setHistoryFilter(path: string | null) {
  setStore("historyFilterPath", path);
  if (path) {
    setStore("gitPanelTab", "history");
    setStore("review", null);
  }
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
let branchRequestSeq = 0;
export async function updateCurrentBranch() {
  const seq = ++branchRequestSeq;
  const projectPath = effectiveRoot();
  if (!projectPath) {
    setStore("currentBranch", "");
    return;
  }
  try {
    const branchName = await getCurrentBranch(projectPath);
    if (seq === branchRequestSeq && effectiveRoot() === projectPath) setStore("currentBranch", branchName || "");
  } catch {
    if (seq === branchRequestSeq && effectiveRoot() === projectPath) setStore("currentBranch", "");
  }
}
