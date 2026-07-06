import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── Types (mirror Rust structs) ──────────────────────────────────────────────

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  installed: boolean;
  version: string | null;
  binary_path: string | null;
  yolo_supported: boolean;
  headless_supported: boolean;
}

export interface ProjectInfo {
  path: string;
  name: string;
  has_agents_md: boolean;
  is_git: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface TextMatch {
  rel_path: string;
  line: number;
  text: string;
  col: number;
  len: number;
}

export interface PromptSkill {
  name: string;
  path: string;
  source: string;
  description: string | null;
}

export interface FileStatus {
  path: string;
  status: string;
}

export interface StatusEntry {
  path: string;
  orig_path: string | null;
  index_status: string;
  worktree_status: string;
}

export interface SyncStatus {
  branch: string;
  detached: boolean;
  head_short_sha: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  has_remote: boolean;
  stash_count: number;
}

export interface PullOutcome {
  merged: boolean;
  conflicted: boolean;
  conflicted_paths: string[];
  message: string;
}

export interface CommitResult {
  sha: string;
  message: string;
}

export interface CommitEntry {
  sha: string;
  short_sha: string;
  message: string;
  time: string;
  author: string;
  date_iso: string;
}

export interface ToolInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  installed: boolean;
  version: string | null;
  install_cmd: string | null;
}

export interface RunTarget {
  id: string;
  label: string;
  command: string;
  kind: string;
  needs_emulator: string | null;
}

export interface AndroidDevice {
  serial: string;
  status: string;
  kind: string;
}

export interface AndroidEnvironment {
  adb_path: string | null;
  emulator_path: string | null;
  scrcpy_path: string | null;
  devices: AndroidDevice[];
  avds: string[];
  selected_device: string | null;
  selected_avd: string | null;
  issues: string[];
}

export interface IosDevice {
  name: string;
  udid: string;
  state: string;
  kind: string;
}

export interface IosEnvironment {
  xcrun_path: string | null;
  physical_devices: IosDevice[];
  simulators: IosDevice[];
  selected_device: string | null;
  selected_simulator: string | null;
  issues: string[];
}

export interface ValidationTarget {
  id: string;
  label: string;
  command: string;
  kind: string;
  category: string;
}

// ── PTY ──────────────────────────────────────────────────────────────────────

export const spawnAgent = (agentId: string, projectPath: string, yolo = false): Promise<string> =>
  invoke("spawn_agent", { agentId, projectPath, yolo });

export const ptyInput = (sessionId: string, data: string): Promise<void> =>
  invoke("pty_input", { sessionId, data });

export const ptyResize = (sessionId: string, cols: number, rows: number): Promise<void> =>
  invoke("pty_resize", { sessionId, cols, rows });

export const ptyKill = (sessionId: string): Promise<void> =>
  invoke("pty_kill", { sessionId });

/** Tell the backend the frontend listeners for this session are in place, so
 *  it may start emitting PTY output events. Must be called after registering
 *  the `pty://{id}` / `pty-exit://{id}` listeners to avoid losing the first
 *  output chunk (which, for query-first TUIs, contains capability queries). */
export const ptyAttach = (sessionId: string): Promise<void> =>
  invoke("pty_attach", { sessionId });

export const openTerminal = (projectPath: string, cwd?: string): Promise<string> =>
  invoke("open_terminal", { projectPath, cwd: cwd ?? null });

export const onPtyOutput = (sessionId: string, cb: (data: string) => void): Promise<UnlistenFn> =>
  listen<string>(`pty://${sessionId}`, (e) => cb(e.payload));

export const onPtyExit = (sessionId: string, cb: () => void): Promise<UnlistenFn> =>
  listen(`pty-exit://${sessionId}`, () => cb());

// ── Agents ───────────────────────────────────────────────────────────────────

export const getAgents = (): Promise<AgentInfo[]> =>
  invoke("get_agents");

// ── Project ──────────────────────────────────────────────────────────────────

export const openProject = (path: string): Promise<ProjectInfo> =>
  invoke("open_project", { path });

export const getRecentProjects = (): Promise<ProjectInfo[]> =>
  invoke("get_recent_projects");

export const getFileTree = (path: string): Promise<FileEntry[]> =>
  invoke("get_file_tree", { path });

export const searchPromptFiles = (
  projectPath: string,
  query: string,
  limit: number,
): Promise<FileEntry[]> =>
  invoke("search_prompt_files", { projectPath, query, limit });

export const searchProjectText = (
  projectPath: string,
  query: string,
  useRegex: boolean,
  caseSensitive: boolean,
  limit: number,
): Promise<TextMatch[]> =>
  invoke("search_project_text", { projectPath, query, useRegex, caseSensitive, limit });

export const listPromptSkills = (projectPath: string | null): Promise<PromptSkill[]> =>
  invoke("list_prompt_skills", { projectPath });

export const injectFileRefs = (sessionId: string, paths: string[]): Promise<void> =>
  invoke("inject_file_refs", { sessionId, paths });

export const createEntry = (parentPath: string, name: string, isDir: boolean): Promise<FileEntry> =>
  invoke("create_entry", { parentPath, name, isDir });

export const renameEntry = (path: string, newName: string): Promise<FileEntry> =>
  invoke("rename_entry", { path, newName });

export const deleteEntry = (path: string): Promise<void> =>
  invoke("delete_entry", { path });

export const duplicateEntry = (path: string): Promise<FileEntry> =>
  invoke("duplicate_entry", { path });

export const copyEntry = (srcPath: string, destDir: string): Promise<FileEntry> =>
  invoke("copy_entry", { srcPath, destDir });

export const moveEntry = (srcPath: string, destDir: string): Promise<FileEntry> =>
  invoke("move_entry", { srcPath, destDir });

export const pickProjectFolder = (): Promise<string | null> =>
  invoke("pick_project_folder");

export const pickPromptFile = (projectPath: string | null, imageOnly = false): Promise<string | null> =>
  invoke("pick_prompt_file", { projectPath, imageOnly });

export const triggerHaptic = (pattern: "generic" | "alignment" | "level-change" | "levelChange"): Promise<void> =>
  invoke<void>("trigger_haptic", { pattern }).catch((error) => {
    if (import.meta.env.DEV) {
      console.debug("Haptic feedback unavailable", error);
    }
  });



// ── Editor ───────────────────────────────────────────────────────────────────

export interface FileContent {
  content: string;
  is_binary: boolean;
  too_large: boolean;
  size: number;
  modified_ms: number;
}

export const readFileText = (projectPath: string, relPath: string): Promise<FileContent> =>
  invoke("read_file_text", { projectPath, relPath });

export const writeFileText = (projectPath: string, relPath: string, content: string): Promise<number> =>
  invoke("write_file_text", { projectPath, relPath, content });

export const statFile = (projectPath: string, relPath: string): Promise<number> =>
  invoke("stat_file", { projectPath, relPath });

export interface LspStatus {
  available: boolean;
  server: string | null;
  message: string;
  tool_id: string | null;
  completion_trigger_characters: string[];
  signature_trigger_characters: string[];
  resolve_provider: boolean;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspCompletion {
  label: string;
  detail: string | null;
  kind: number | null;
  insert_text: string;
  sort_text: string | null;
  filter_text: string | null;
  documentation: string | null;
  replace_start: LspPosition | null;
  raw: unknown;
}

export interface LspCompletionDetail {
  detail: string | null;
  documentation: string | null;
}

export interface LspSignatureParameter {
  label: string;
  documentation: string | null;
}

export interface LspSignature {
  label: string;
  documentation: string | null;
  parameters: LspSignatureParameter[];
}

export interface LspSignatureHelp {
  signatures: LspSignature[];
  active_signature: number;
  active_parameter: number;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: number | null;
  message: string;
}

export interface LspDefinition {
  path: string;
  line: number;
  character: number;
}

export const lspStatus = (projectPath: string, relPath: string): Promise<LspStatus> =>
  invoke("lsp_status", { projectPath, relPath });

export const lspOpenDocument = (
  projectPath: string,
  relPath: string,
  content: string,
): Promise<LspStatus> =>
  invoke("lsp_open_document", { projectPath, relPath, content });

export const lspChangeDocument = (
  projectPath: string,
  relPath: string,
  content: string,
): Promise<LspStatus> =>
  invoke("lsp_change_document", { projectPath, relPath, content });

export const lspCompletion = (
  projectPath: string,
  relPath: string,
  line: number,
  character: number,
  triggerCharacter?: string,
): Promise<LspCompletion[]> =>
  invoke("lsp_completion", { projectPath, relPath, line, character, triggerCharacter: triggerCharacter ?? null });

export const lspCompletionResolve = (
  projectPath: string,
  relPath: string,
  item: unknown,
): Promise<LspCompletionDetail> =>
  invoke("lsp_completion_resolve", { projectPath, relPath, item });

export const lspSignatureHelp = (
  projectPath: string,
  relPath: string,
  line: number,
  character: number,
): Promise<LspSignatureHelp | null> =>
  invoke("lsp_signature_help", { projectPath, relPath, line, character });

export const lspHover = (
  projectPath: string,
  relPath: string,
  line: number,
  character: number,
): Promise<string | null> =>
  invoke("lsp_hover", { projectPath, relPath, line, character });

export const lspDefinition = (
  projectPath: string,
  relPath: string,
  line: number,
  character: number,
): Promise<LspDefinition | null> =>
  invoke("lsp_definition", { projectPath, relPath, line, character });

export const lspReferences = (
  projectPath: string,
  relPath: string,
  line: number,
  character: number,
): Promise<LspDefinition[]> =>
  invoke("lsp_references", { projectPath, relPath, line, character });

export const lspDiagnostics = (
  projectPath: string,
  relPath: string,
): Promise<LspDiagnostic[]> =>
  invoke("lsp_diagnostics", { projectPath, relPath });

export const lspShutdownProject = (projectPath: string): Promise<void> =>
  invoke("lsp_shutdown_project", { projectPath });

// ── Git ──────────────────────────────────────────────────────────────────────

export const getGitStatus = (projectPath: string): Promise<FileStatus[]> =>
  invoke("get_git_status", { projectPath });

export const getGitStatusV2 = (projectPath: string): Promise<StatusEntry[]> =>
  invoke("get_git_status_v2", { projectPath });

export const getSyncStatus = (projectPath: string): Promise<SyncStatus> =>
  invoke("get_sync_status", { projectPath });

export const ensureWorkBranch = (projectPath: string, branch: string): Promise<string> =>
  invoke("ensure_work_branch", { projectPath, branch });

export const getCurrentBranch = (projectPath: string): Promise<string> =>
  invoke("get_current_branch", { projectPath });

export const getRecentBranches = (projectPath: string, limit: number): Promise<string[]> =>
  invoke("get_recent_branches", { projectPath, limit });

export const gitSwitchBranch = (projectPath: string, branchName: string): Promise<void> =>
  invoke("git_switch_branch", { projectPath, branchName });


export const getGitLog = (projectPath: string, limit: number, path?: string): Promise<CommitEntry[]> =>
  invoke("get_git_log", { projectPath, limit, path: path ?? null });

export const gitRollback = (projectPath: string, sha: string): Promise<void> =>
  invoke("git_rollback", { projectPath, sha });

export const renameCommit = (projectPath: string, sha: string, message: string): Promise<void> =>
  invoke("rename_commit", { projectPath, sha, message });

export const gitStage = (projectPath: string, paths: string[]): Promise<void> =>
  invoke("git_stage", { projectPath, paths });

export const gitUnstage = (projectPath: string, paths: string[]): Promise<void> =>
  invoke("git_unstage", { projectPath, paths });

export const gitDiscard = (projectPath: string, tracked: string[], untracked: string[]): Promise<void> =>
  invoke("git_discard", { projectPath, tracked, untracked });

export const gitCommit = (
  projectPath: string,
  message: string,
  all: boolean,
  amend: boolean,
): Promise<CommitResult> =>
  invoke("git_commit", { projectPath, message, all, amend });

export const gitStashPush = (projectPath: string, message?: string): Promise<void> =>
  invoke("git_stash_push", { projectPath, message: message ?? null });

export const gitStashPop = (projectPath: string): Promise<void> =>
  invoke("git_stash_pop", { projectPath });

export const gitFetch = (projectPath: string): Promise<void> =>
  invoke("git_fetch", { projectPath });

export const gitPull = (projectPath: string): Promise<PullOutcome> =>
  invoke("git_pull", { projectPath });

export const gitPush = (projectPath: string): Promise<string> =>
  invoke("git_push", { projectPath });

export const gitCheckoutCommit = (projectPath: string, sha: string): Promise<void> =>
  invoke("git_checkout_commit", { projectPath, sha });

export const gitCheckoutPrevious = (projectPath: string): Promise<void> =>
  invoke("git_checkout_previous", { projectPath });

export const commitsAheadOfRemote = (projectPath: string): Promise<CommitEntry[]> =>
  invoke("commits_ahead_of_remote", { projectPath });

export const squashUnpushed = (projectPath: string, message: string): Promise<void> =>
  invoke("squash_unpushed", { projectPath, message });

export const generateCommitMessage = (projectPath: string, agentId: string): Promise<string> =>
  invoke("generate_commit_message", { projectPath, agentId });

// ── Native diff review ───────────────────────────────────────────────────────

export interface DiffLine {
  kind: "context" | "add" | "del";
  old_lineno: number | null;
  new_lineno: number | null;
  content: string;
}

export interface Hunk {
  header: string;
  old_start: number;
  new_start: number;
  lines: DiffLine[];
}

export interface FileDiff {
  old_path: string | null;
  new_path: string | null;
  /** "added" | "modified" | "deleted" | "renamed" | "binary" */
  status: string;
  is_binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

/** Return structured diffs for the native review pane.
 *  `rev=undefined` → working-tree vs HEAD; `rev="sha~1..sha"` → commit diff.
 *  `path` optionally scopes to one file (relative to project root).
 *  `mode="staged"|"unstaged"` scopes to the index or worktree only, ignoring `rev`. */
export const getReviewDiff = (
  projectPath: string,
  rev?: string,
  path?: string,
  mode?: "staged" | "unstaged",
): Promise<FileDiff[]> =>
  invoke("get_review_diff", { projectPath, rev: rev ?? null, path: path ?? null, mode: mode ?? null });

// ── Tools ────────────────────────────────────────────────────────────────────

export const getToolCatalog = (): Promise<ToolInfo[]> =>
  invoke("get_tool_catalog");

export const installTool = (toolId: string, projectPath: string): Promise<string> =>
  invoke("install_tool", { toolId, projectPath });

// ── Runner ───────────────────────────────────────────────────────────────────

export const detectRunTargets = (projectPath: string): Promise<RunTarget[]> =>
  invoke("detect_run_targets", { projectPath });

export const detectAndroidEnvironment = (projectPath: string): Promise<AndroidEnvironment> =>
  invoke("detect_android_environment", { projectPath });

export const detectIosEnvironment = (projectPath: string): Promise<IosEnvironment> =>
  invoke("detect_ios_environment", { projectPath });

export const runProject = (projectPath: string, targetId?: string): Promise<string> =>
  invoke("run_project", { projectPath, targetId: targetId ?? null });

export const startAndroidScrcpy = (projectPath: string, serial?: string): Promise<string> =>
  invoke("start_android_scrcpy", { projectPath, serial: serial ?? null });

export const openIosSimulator = (projectPath: string, udid?: string): Promise<string> =>
  invoke("open_ios_simulator", { projectPath, udid: udid ?? null });

export const detectValidationTargets = (projectPath: string): Promise<ValidationTarget[]> =>
  invoke("detect_validation_targets", { projectPath });

export const validateProject = (projectPath: string, targetId?: string): Promise<string> =>
  invoke("validate_project", { projectPath, targetId: targetId ?? null });

// ── Preview ──────────────────────────────────────────────────────────────────

export interface PreviewTarget {
  name: string;
  line: number;
  label: string | null;
}

export interface PreviewImage {
  rel_path: string;
  label: string;
  target_name: string | null;
  modified_ms: number;
  size: number;
}

export interface LivePreviewSpec {
  id: string;
  label: string;
  /** null → the frontend reuses the existing Run flow (web dev server). */
  command: string | null;
}

export interface RecordAction {
  id: string;
  label: string;
  command: string;
}

export interface ComposeState {
  module_rel: string;
  target: "android" | "desktop" | "multiplatform" | "compose";
  screenshot_setup: "paparazzi" | "roborazzi" | "compose-screenshot" | null;
  setup_url: string | null;
  package: string | null;
}

export interface PreviewInfo {
  /** "compose" | "swift" | "flutter" | "react-native" | "web" | "generic" | "none" */
  kind: string;
  targets: PreviewTarget[];
  images: PreviewImage[];
  live: LivePreviewSpec | null;
  record: RecordAction | null;
  verify: RecordAction | null;
  compose: ComposeState | null;
}

export const detectPreview = (projectPath: string, relPath: string): Promise<PreviewInfo> =>
  invoke("detect_preview", { projectPath, relPath });

export const readPreviewImage = (projectPath: string, relPath: string): Promise<string> =>
  invoke("read_preview_image", { projectPath, relPath });

export const startPreviewSession = (
  projectPath: string,
  relPath: string,
  previewId: string,
): Promise<string> =>
  invoke("start_preview_session", { projectPath, relPath, previewId });

export const getSessionUrl = (sessionId: string): Promise<string | null> =>
  invoke("get_session_url", { sessionId });

export const onPreviewUrl = (sessionId: string, cb: (url: string) => void): Promise<UnlistenFn> =>
  listen<string>(`preview-url://${sessionId}`, (e) => cb(e.payload));

// ── Handoff ──────────────────────────────────────────────────────────────────

export const continueAgent = (projectPath: string, fromAgent: string, toAgent: string, yolo = false): Promise<string> =>
  invoke("continue_agent", { projectPath, fromAgent, toAgent, yolo });

// ── Native menu ──────────────────────────────────────────────────────────────

export interface NativeMenuState {
  hasProject: boolean;
  hasActiveAgent: boolean;
  workspaceMode: "code" | "review" | "agent";
  yoloMode: boolean;
  explorerCollapsed: boolean;
  gitPanelCollapsed: boolean;
  terminalPanelOpen: boolean;
  autoToggleSidebars: boolean;
  gitPanelTab: "changes" | "history";
}

export const syncNativeMenuState = (state: NativeMenuState): Promise<void> =>
  invoke("sync_native_menu_state", { state });

export const onNativeMenuCommand = (cb: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>("native-menu-command", (e) => cb(e.payload));
