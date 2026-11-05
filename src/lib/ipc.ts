import { Channel, invoke } from "@tauri-apps/api/core";
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
  headless_supported: boolean;
  /** Can run as a chat session (see `chat` in the Rust backend). */
  chat_supported: boolean;
}

export interface ProjectInfo {
  path: string;
  name: string;
  has_agents_md: boolean;
  is_git: boolean;
}

/** A project's own launcher/app icon, found by the backend. */
export interface ProjectIconInfo {
  /** Project type that supplied it: android, ios, tauri, web, … */
  kind: string;
  /** Human-readable label for project settings. */
  label: string;
  /** Project-relative path of the source asset. */
  source: string;
  /** Absolute file for the asset protocol (raster or an extracted PNG frame). */
  path: string | null;
  /** Inline SVG data URL when the source is vector art. */
  data_url: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface PromptSkill {
  name: string;
  path: string;
  source: string;
  description: string | null;
}

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http" | "sse" | string;
  target: string;
  source: string;
  scope: "project" | "user" | string;
  agents: string[];
  enabled: boolean;
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

export interface WorktreeInfo {
  worktree_path: string;
  branch: string;
  source_branch: string;
}
export interface ManagedWorktree { path: string; branch: string; dirty: boolean }
export const listWorktrees = (projectPath: string): Promise<ManagedWorktree[]> => invoke("list_worktrees", { projectPath });

export interface WorktreeStatus {
  dirty: boolean;
  commits_ahead: number;
  exists: boolean;
}

export interface MergeOutcome {
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

export interface BranchInfo {
  name: string;
  remote_ref: string | null;
  is_remote: boolean;
  upstream: string | null;
  last_commit_time: string;
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
  model: string | null;
}

export interface AndroidEnvironment {
  adb_path: string | null;
  emulator_path: string | null;
  scrcpy_path: string | null;
  scrcpy_version: string | null;
  scrcpy_server_path: string | null;
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
  idb_path: string | null;
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

export interface SingleInstancePayload {
  args: string[];
  cwd: string;
}

// ── PTY ──────────────────────────────────────────────────────────────────────

export const ptyInput = (sessionId: string, data: string): Promise<void> =>
  invoke("pty_input", { sessionId, data });

/** Send a line of input to a PTY session as if the user typed the body and
 *  then pressed Enter. The body and the submit keystroke are written as two
 *  separate PTY writes (with a brief yield between them) so the `\r` lands in
 *  its own read: TUI agents such as Claude Code treat a multi-byte chunk
 *  ending in a newline as a paste and swallow the trailing Enter, leaving the
 *  prompt unsent. Do not collapse this back into a single `data + "\r"` write. */
export const ptySendLine = async (sessionId: string, data: string): Promise<void> => {
  await ptyInput(sessionId, data);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await ptyInput(sessionId, "\r");
};

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

export const onSingleInstance = (cb: (payload: SingleInstancePayload) => void): Promise<UnlistenFn> =>
  listen<SingleInstancePayload>("single-instance", (event) => cb(event.payload));

/** flipflopper:// links delivered by the OS while the window was loading. */
export const drainOpenLinks = (): Promise<string[]> => invoke("drain_open_links");

/** A real child webview used for per-preview DevTools. */
export const openPreviewInspector = (url: string, x: number, y: number, width: number, height: number): Promise<void> =>
  invoke("open_preview_inspector", { url, x, y, width, height });
export const setPreviewInspectorBounds = (x: number, y: number, width: number, height: number): Promise<void> =>
  invoke("set_preview_inspector_bounds", { x, y, width, height });
export const navigatePreviewInspector = (url: string): Promise<void> =>
  invoke("navigate_preview_inspector", { url });
export const closePreviewInspector = (): Promise<void> => invoke("close_preview_inspector");

/** Cookie-backed native browser profile for the preview. */
export interface BrowserProfileInfo { id: string; name: string; created_at: number; cookie_count: number; domains: string[] }
export interface ListeningServer { port: number; pid: number; process: string; address: string }
/** Local TCP listeners shown in the preview empty state. */
export const listListeningServers = (): Promise<ListeningServer[]> => invoke("list_listening_servers");
/** Run project setup commands in a fresh worktree before the agent starts. */
export const runSetupCommands = (cwd: string, commands: string[]): Promise<string> => invoke("run_setup_commands", { cwd, commands });
export const listBrowserProfiles = (): Promise<BrowserProfileInfo[]> => invoke("list_browser_profiles");
export const createBrowserProfile = (name: string): Promise<BrowserProfileInfo> => invoke("create_browser_profile", { name });
export const deleteBrowserProfile = (id: string): Promise<void> => invoke("delete_browser_profile", { id });
export const importBrowserCookies = (id: string, path: string): Promise<number> => invoke("import_browser_cookies", { id, path });
export const importFirefoxCookies = (id: string): Promise<number> => invoke("import_firefox_cookies", { id });
export const pickBrowserCookieFile = (): Promise<string | null> => invoke("pick_browser_cookie_file");
export const openPreviewProfile = (url: string, x: number, y: number, width: number, height: number, profileId: string): Promise<void> =>
  invoke("open_preview_profile", { url, x, y, width, height, profileId });
export const setPreviewProfileBounds = (x: number, y: number, width: number, height: number): Promise<void> =>
  invoke("set_preview_profile_bounds", { x, y, width, height });
export const navigatePreviewProfile = (url: string): Promise<void> => invoke("navigate_preview_profile", { url });
export const openPreviewProfileDevtools = (): Promise<void> => invoke("open_preview_profile_devtools");
export const closePreviewProfile = (): Promise<void> => invoke("close_preview_profile");

export interface PreviewPickRect { x: number; y: number; width: number; height: number; dpr: number }
export interface PreviewPick { url: string; title: string; selector: string; text: string; rect: PreviewPickRect }
/** Native element picker over the preview stage. */
export const openPreviewPicker = (url: string, x: number, y: number, width: number, height: number, profileId?: string | null): Promise<void> =>
  invoke("open_preview_picker", { url, x, y, width, height, profileId: profileId ?? null });
export const closePreviewPicker = (): Promise<void> => invoke("close_preview_picker");
export const capturePreviewRegion = (x: number, y: number, width: number, height: number): Promise<string> =>
  invoke("capture_preview_region", { x, y, width, height });
export const startPreviewRecording = (x: number, y: number, width: number, height: number): Promise<void> =>
  invoke("start_preview_recording", { x, y, width, height });
export const stopPreviewRecording = (): Promise<string> => invoke("stop_preview_recording");
export const onPreviewPick = (cb: (payload: PreviewPick) => void): Promise<UnlistenFn> =>
  listen<PreviewPick>("preview-pick", (event) => cb(event.payload));
export const onPreviewPickCancel = (cb: () => void): Promise<UnlistenFn> =>
  listen("preview-pick-cancel", () => cb());

/** The user tried to quit (Cmd+Q, menu or last window) while `running` agents were still working. */
export const onQuitRequested = (cb: (running: number) => void): Promise<UnlistenFn> =>
  listen<number>("app://quit-requested", (event) => cb(event.payload));

// ── Agents ───────────────────────────────────────────────────────────────────

export const getAgents = (includeVersions = true): Promise<AgentInfo[]> =>
  invoke("get_agents", { includeVersions });

// ── Project ──────────────────────────────────────────────────────────────────

export const openProject = (path: string): Promise<ProjectInfo> =>
  invoke("open_project", { path });

/** Detect the default icon the project already ships (launcher icon, favicon, …). */
export const detectProjectIcon = (projectPath: string): Promise<ProjectIconInfo | null> =>
  invoke("detect_project_icon", { projectPath });

export const setupProject = (path: string): Promise<ProjectInfo> =>
  invoke("setup_project", { path });

export const createProject = (parentPath: string, name: string): Promise<ProjectInfo> =>
  invoke("create_project", { parentPath, name });

export const getRecentProjects = (): Promise<ProjectInfo[]> =>
  invoke("get_recent_projects");

export const removeRecentProject = (projectPath: string): Promise<void> =>
  invoke("remove_recent_project", { projectPath });

export const searchPromptFiles = (
  projectPath: string,
  query: string,
  limit: number,
): Promise<FileEntry[]> =>
  invoke("search_prompt_files", { projectPath, query, limit });

/** A matching line from project-wide content search. */
export interface ContentMatch {
  path: string;
  line: number;
  text: string;
  column: number;
}
export const searchProjectContent = (
  root: string,
  query: string,
  options: { caseSensitive?: boolean; wholeWord?: boolean } = {},
  limit = 200,
): Promise<ContentMatch[]> =>
  invoke("search_project_content", {
    root,
    query,
    caseSensitive: !!options.caseSensitive,
    wholeWord: !!options.wholeWord,
    limit,
  });

export const listPromptSkills = (projectPath: string | null): Promise<PromptSkill[]> =>
  invoke("list_prompt_skills", { projectPath });

export const listMcpServers = (projectPath: string | null): Promise<McpServerInfo[]> =>
  invoke("list_mcp_servers", { projectPath });

/** Execute a tool on a configured stdio MCP server for an MCP App. */
export const mcpCallTool = (projectPath: string, server: string, tool: string, args: Record<string, unknown>): Promise<unknown> =>
  invoke("mcp_call_tool", { projectPath, server, tool, arguments: args });

export const pickProjectFolder = (): Promise<string | null> =>
  invoke("pick_project_folder");

/** Choose a parent folder for a clone. */
export const pickCloneDestination = (): Promise<string | null> =>
  invoke("pick_clone_destination");

/** Clone a repository into a new folder under `destinationParent` and inspect it. */
export const cloneRepository = (url: string, destinationParent: string): Promise<ProjectInfo> =>
  invoke("clone_repository", { url, destinationParent });

/** Create a GitHub repository for a checkout with `gh repo create --source . --push`. */
export const publishRepository = (projectPath: string, name: string, privateRepo: boolean, description?: string): Promise<string> =>
  invoke("publish_repository", { projectPath, name, private: privateRepo, description });

export const triggerHaptic = (pattern: "generic" | "alignment" | "level-change" | "levelChange"): Promise<void> =>
  invoke<void>("trigger_haptic", { pattern }).catch((error) => {
    if (import.meta.env.DEV) {
      console.debug("Haptic feedback unavailable", error);
    }
  });



// ── Git ──────────────────────────────────────────────────────────────────────

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

export const gitListBranches = (projectPath: string, limit = 250): Promise<BranchInfo[]> =>
  invoke("git_list_branches", { projectPath, limit });

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

export const gitApplyPatch = (
  projectPath: string,
  patch: string,
  cached: boolean,
  reverse: boolean,
): Promise<void> =>
  invoke("git_apply_patch", { projectPath, patch, cached, reverse });

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

export const gitRemoteUrl = (projectPath: string): Promise<string | null> =>
  invoke("git_remote_url", { projectPath });

/** Arguments the app was launched with, for prompt/thread links passed on the command line. */
export const launchArgs = (): Promise<string[]> => invoke("launch_args");

export const gitCheckoutCommit = (projectPath: string, sha: string): Promise<void> =>
  invoke("git_checkout_commit", { projectPath, sha });

export const gitCheckoutPrevious = (projectPath: string): Promise<void> =>
  invoke("git_checkout_previous", { projectPath });

export const commitsAheadOfRemote = (projectPath: string): Promise<CommitEntry[]> =>
  invoke("commits_ahead_of_remote", { projectPath });

export const squashUnpushed = (projectPath: string, message: string): Promise<void> =>
  invoke("squash_unpushed", { projectPath, message });

export type ExplainProvider =
  | { kind: "agent"; agent_id: string; model?: string | null }
  | { kind: "ollama"; model: string };
export interface ExplainResult { text: string; source: string }

export const chatExplain = (sessionId: string, provider: ExplainProvider, language: string): Promise<ExplainResult> =>
  invoke("chat_explain", { sessionId, provider, language });
export const chatGenerateSessionTitle = (sessionId: string, provider: ExplainProvider, language: string): Promise<string> =>
  invoke("chat_generate_session_title", { sessionId, provider, language });
export const listOllamaModels = (): Promise<string[]> => invoke("list_ollama_models");
export interface AgentModelChoice { id: string; label: string; efforts: string[] }
export const listAgentModels = (agentId: string): Promise<AgentModelChoice[]> => invoke("list_agent_models", { agentId });

export const generateCommitMessage = (projectPath: string, agentId: string): Promise<string> =>
  invoke("generate_commit_message", { projectPath, agentId });

export interface AutoPullResult { branch: string; pulled: boolean; reason: string }
/** Fast-forward the clean checkout from its upstream when possible; never merges. */
export const autoPull = (projectPath: string): Promise<AutoPullResult> =>
  invoke("auto_pull", { projectPath });

export const createWorktree = (projectPath: string, agentId: string, branchPrefix?: string, baseBranch?: string | null): Promise<WorktreeInfo> =>
  invoke("create_worktree", { projectPath, agentId, branchPrefix: branchPrefix ?? null, baseBranch: baseBranch ?? null });

/** A pull request head checked out in a fresh worktree (`worktree.source_branch` is the PR head commit). */
export interface PrReview {
  number: number;
  title: string | null;
  body: string | null;
  /** Remote-tracking ref to diff against, e.g. `origin/main`. */
  base_ref: string;
  head_sha: string;
  worktree: WorktreeInfo;
}
export const preparePrReview = (projectPath: string, input: string): Promise<PrReview> =>
  invoke("prepare_pr_review", { projectPath, input });

export const getWorktreeStatus = (worktreePath: string, sourceBranch: string): Promise<WorktreeStatus> =>
  invoke("get_worktree_status", { worktreePath, sourceBranch });

export const commitWorktree = (worktreePath: string, message: string): Promise<string | null> =>
  invoke("commit_worktree", { worktreePath, message });

export const mergeWorktreeBranch = (projectPath: string, branch: string): Promise<MergeOutcome> =>
  invoke("merge_worktree_branch", { projectPath, branch });

export const removeWorktree = (projectPath: string, worktreePath: string, branch: string, deleteBranch: boolean): Promise<void> =>
  invoke("remove_worktree", { projectPath, worktreePath, branch, deleteBranch });

export const generateWorktreeCommitMessage = (worktreePath: string, sourceBranch: string, agentId: string): Promise<string> =>
  invoke("generate_worktree_commit_message", { worktreePath, sourceBranch, agentId });

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
  ignoreWhitespace = false,
): Promise<FileDiff[]> =>
  invoke("get_review_diff", { projectPath, rev: rev ?? null, path: path ?? null, mode: mode ?? null, ignoreWhitespace });

export interface ReviewMediaSide {
  path: string;
  name: string;
  size: number;
  mtime?: number | null;
  mime: string;
  exists: boolean;
}

export interface ReviewMediaDiff {
  kind: "image" | "video";
  file_name: string;
  before: ReviewMediaSide | null;
  after: ReviewMediaSide | null;
}

/** Return media comparison information for an image or video in the review pane.
 *  Grants asset protocol scope to both before and after files. */
export const getReviewMedia = (
  projectPath: string,
  path: string,
  oldPath?: string | null,
  newPath?: string | null,
  rev?: string,
  mode?: "staged" | "unstaged",
): Promise<ReviewMediaDiff> =>
  invoke("get_review_media", {
    projectPath,
    path,
    oldPath: oldPath ?? null,
    newPath: newPath ?? null,
    rev: rev ?? null,
    mode: mode ?? null,
  });

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

export const runProject = (
  projectPath: string,
  targetId?: string,
  androidSerial?: string,
  androidAvd?: string,
  iosUdid?: string,
): Promise<string> =>
  invoke("run_project", {
    projectPath,
    targetId: targetId ?? null,
    androidSerial: androidSerial ?? null,
    androidAvd: androidAvd ?? null,
    iosUdid: iosUdid ?? null,
  });

/** Cheap device polls for the Preview tab (no full environment probe). */
export const androidListDevices = (): Promise<AndroidDevice[]> => invoke("android_list_devices");
export const iosListSimulators = (): Promise<IosDevice[]> => invoke("ios_list_simulators");

export const startAndroidScrcpy = (projectPath: string, serial?: string): Promise<string> =>
  invoke("start_android_scrcpy", { projectPath, serial: serial ?? null });

export const startAndroidLogcat = (projectPath: string, serial?: string): Promise<string> =>
  invoke("start_android_logcat", { projectPath, serial: serial ?? null });

export const bootAndroidEmulator = (
  projectPath: string,
  avd: string,
  opts?: { cold?: boolean; wipe?: boolean; headless?: boolean },
): Promise<string> =>
  invoke("boot_android_emulator", {
    projectPath,
    avd,
    cold: opts?.cold ?? null,
    wipe: opts?.wipe ?? null,
    headless: opts?.headless ?? null,
  });

// ── Android device mirror (Preview tab) ──────────────────────────────────────

export interface MirrorInfo {
  device_name: string;
  width: number;
  height: number;
}

/** Start mirroring `serial` through the installed scrcpy's server. Every
 *  packet arrives as `[flags u8][pts u64 LE][annex-b bytes]`
 *  (flags: 1 config, 2 key frame, 0x80 stream closed). */
export const androidMirrorStart = (
  projectPath: string,
  serial: string,
  onPacket: (packet: ArrayBuffer) => void,
  maxSize?: number,
): Promise<MirrorInfo> => {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = onPacket;
  return invoke("android_mirror_start", {
    projectPath,
    serial,
    maxSize: maxSize ?? null,
    onFrame: channel,
  });
};

export const androidMirrorControl = (serial: string, bytes: Uint8Array): Promise<void> =>
  invoke("android_mirror_control", { serial, bytes: Array.from(bytes) });

export const androidMirrorStop = (serial: string): Promise<void> =>
  invoke("android_mirror_stop", { serial });

/** PNG bytes of the current screen (slow snapshot fallback). */
export const androidScreencap = (serial: string): Promise<ArrayBuffer> =>
  invoke("android_screencap", { serial });

export const androidInput = (
  serial: string,
  kind: "tap" | "swipe" | "key" | "text",
  args: (string | number)[],
): Promise<void> => invoke("android_input", { serial, kind, args: args.map(String) });

export type AndroidDeviceAction =
  | "force-stop"
  | "clear-data"
  | "uninstall"
  | "restart"
  | "screenshot"
  | "screenrecord";

export const runAndroidDeviceAction = (
  projectPath: string,
  action: AndroidDeviceAction,
  serial?: string,
): Promise<string> =>
  invoke("run_android_device_action", { projectPath, action, serial: serial ?? null });

export const sendAndroidDeeplink = (
  projectPath: string,
  uri: string,
  serial?: string,
): Promise<string> =>
  invoke("send_android_deeplink", { projectPath, uri, serial: serial ?? null });

// ── iOS Simulator mirror (Preview tab) ───────────────────────────────────────

export interface IosMirrorInfo {
  width_points: number;
  height_points: number;
}

/** Boot a simulator without opening Simulator.app; resolves once it is usable. */
export const iosBootSimulator = (udid: string): Promise<void> =>
  invoke("ios_boot_simulator", { udid });

/** Live H.264 stream through idb (same packet format as the Android mirror). */
export const iosMirrorStart = (udid: string, onPacket: (packet: ArrayBuffer) => void): Promise<IosMirrorInfo> => {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = onPacket;
  return invoke("ios_mirror_start", { udid, onFrame: channel });
};

export const iosMirrorStop = (udid: string): Promise<void> => invoke("ios_mirror_stop", { udid });

/** PNG bytes of the simulator screen (`simctl io screenshot`). */
export const iosScreenshot = (udid: string): Promise<ArrayBuffer> => invoke("ios_screenshot", { udid });

export const iosInput = (
  udid: string,
  kind: "tap" | "swipe" | "text" | "key" | "button",
  args: (string | number)[],
): Promise<void> => invoke("ios_input", { udid, kind, args: args.map(String) });

export const iosRecordStart = (udid: string): Promise<void> => invoke("ios_record_start", { udid });

/** Stops `simctl io recordVideo` and returns the finished mp4 as an attachment. */
export const iosRecordStop = (udid: string): Promise<Attachment> => invoke("ios_record_stop", { udid });

export const openIosSimulator = (projectPath: string, udid?: string): Promise<string> =>
  invoke("open_ios_simulator", { projectPath, udid: udid ?? null });

export const detectValidationTargets = (projectPath: string): Promise<ValidationTarget[]> =>
  invoke("detect_validation_targets", { projectPath });

export const validateProject = (projectPath: string, targetId?: string): Promise<string> =>
  invoke("validate_project", { projectPath, targetId: targetId ?? null });

// ── Preview / dev-server URL capture ─────────────────────────────────────────

export const getSessionUrl = (sessionId: string): Promise<string | null> =>
  invoke("get_session_url", { sessionId });

export const onPreviewUrl = (sessionId: string, cb: (url: string) => void): Promise<UnlistenFn> =>
  listen<string>(`preview-url://${sessionId}`, (e) => cb(e.payload));

// ── Chat sessions ────────────────────────────────────────────────────────────

export type PermissionMode = "manual" | "auto_edit" | "plan" | "ask";
/** Persisted data from before YOLO became a separate toggle may still say `full`. */
export type StoredPermissionMode = PermissionMode | "full";
export type ToolKind = "read" | "edit" | "write" | "bash" | "search" | "web" | "todo" | "other";
export type TurnStatus = "done" | "error" | "cancelled";

export interface ChangedFile {
  path: string;
  /** "added" | "modified" | "deleted" */
  status: string;
}

export interface AgentOption {
  id: string; name: string; category?: string; type: string;
  currentValue?: string | boolean;
  options?: { value?: string; name?: string; options?: { value: string; name: string }[] }[];
}
export interface FormField {
  type: "string" | "boolean" | "number" | "integer" | "array";
  title?: string; description?: string; default?: unknown;
  enum?: string[]; enumNames?: string[]; oneOf?: { const: string; title?: string }[];
  items?: { type?: string; enum?: string[]; enumNames?: string[]; anyOf?: { const: string; title?: string; description?: string }[] };
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number;
}
export interface AgentInteraction {
  id: string; turn_id: string; kind: "permission" | "form" | "question" | "plan" | "url"; title: string;
  payload: {
    message?: string; url?: string; plan?: string; overview?: string;
    options?: { optionId: string; name: string; kind: string }[];
    toolCall?: { title?: string; kind?: string; rawInput?: unknown };
    requestedSchema?: { type: string; properties: Record<string, FormField>; required?: string[] };
    questions?: { id: string; prompt: string; options: { id: string; label: string }[]; allowMultiple?: boolean }[];
  };
}
export type InteractionResponse =
  | { kind: "permission"; option_id: string | null }
  | { kind: "form"; action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }
  | { kind: "question"; action: "accept" | "decline" | "cancel"; answers?: { questionId: string; selectedOptionIds: string[] }[] }
  | { kind: "plan"; accepted: boolean; reason: string | null; cancelled?: boolean }
  | { kind: "url"; action: "accept" | "decline" | "cancel" };
export interface AgentRuntimeState {
  terminal_id?: string | null;
  connected: boolean; active_turn_id?: string | null; agent_id: string; native_session_id: string | null; agent_version: string | null;
  capabilities: Record<string, unknown> | null; config_options: AgentOption[];
  modes: { id: string; name: string; description?: string }[];
  current_mode: string | null; commands: { name: string; description: string; input?: { hint?: string } | null }[]; pending: AgentInteraction[];
  permission_mode?: StoredPermissionMode | null;
  /** Auto-approve toggle, independent of `permission_mode`. */
  yolo?: boolean;
}
export interface AgentRuntimeInfo { available: boolean; detail: string; protocol: string; node_version: string | null; helper_version: string | null }

/** A self-contained MCP Apps UI resource attached to a tool call. */
export interface McpAppData {
  server: string;
  tool: string;
  resource_uri: string;
  title: string;
  html: string;
  structured_content: unknown | null;
  csp: Record<string, unknown> | null;
  permissions: Record<string, unknown> | null;
  prefers_border: boolean;
}

export type ChatEvent =
  | { type: "turn_started"; turn_id: string; agent_id: string; checkpoint?: string | null }
  | { type: "native_session"; id: string }
  | { type: "model"; name: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; kind: ToolKind; title: string; input: unknown }
  | { type: "runtime_updated"; state: AgentRuntimeState }
  | { type: "interaction_requested"; request: AgentInteraction }
  | { type: "interaction_resolved"; id: string; outcome: string }
  | { type: "tool_updated"; id: string; title: string | null; input: unknown | null; kind?: ToolKind | null }
  | { type: "tool_result"; id: string; ok: boolean; output: string }
  | { type: "mcp_app"; tool_id: string; app: McpAppData }
  | { type: "context_usage"; used: number; size: number; cost_usd: number | null }
  | { type: "title_changed"; title: string }
  | { type: "subagent"; id: string; title?: string | null; description?: string | null; prompt?: string | null; state?: string | null; stop_reason?: string | null; error?: string | null; launched_by?: string | null }
  | { type: "subagent_tool"; id: string; subagent: string }
  | { type: "notice"; severity: string; title: string; description?: string | null }
  | { type: "compaction"; id: string; status: string; summary?: string | null; error?: string | null }
  | { type: "usage"; input_tokens: number; output_tokens: number; cost_usd: number | null }
  | { type: "turn_ended"; turn_id: string; status: TurnStatus; changed_files: ChangedFile[] }
  | { type: "error"; message: string };

/** One transcript line; also the payload of the live `chat://{id}` event. */
export interface Attachment {
  path: string;
  name: string;
  /** "file" | "image" */
  kind: "file" | "image";
}

export type ChatEntry =
  | { kind: "user"; text: string; agent_id: string; ts: number; attachments?: Attachment[] }
  | { kind: "divider"; from: string; to: string; ts: number }
  | { kind: "event"; event: ChatEvent; ts: number };

export interface WorktreeRef {
  path: string;
  branch: string;
  source_branch: string;
}

export interface SessionMeta {
  id: string;
  project_path: string;
  /** Directory agents run in: the project, or the worktree path. */
  cwd: string;
  worktree: WorktreeRef | null;
  title: string;
  /** True once the user renamed the session; agent-generated titles stop applying. */
  title_locked?: boolean;
  agent_id: string;
  model: string | null;
  effort: string | null;
  mode: PermissionMode;
  /** Auto-approve every tool request; independent of `mode`. */
  yolo?: boolean;
  native_ids: Record<string, string>;
  acp_sessions?: Record<string, { session_id: string; cwd: string }>;
  entry_count: number;
  /** "idle" | "running" | "error" */
  status: string;
  archived: boolean;
  pinned: boolean;
  parent_id: string | null;
  goal?: Goal | null;
  /** Hidden from the main list until this time (ms); woken early when it needs you. */
  snoozed_until?: number | null;
  /** Opt-out of automatic settlement (idle archiving) for this session. */
  settle_disabled?: boolean;
  /** A throwaway side-question session: never listed. */
  hidden?: boolean;
  /** Shared by sessions started together by one multi-agent send. */
  compare_group?: string | null;
  created_at: number;
  updated_at: number;
}

/** One durable objective per session; `src/lib/goals.ts` drives the rounds. */
export interface Goal {
  text: string;
  status: "active" | "paused" | "done" | "blocked";
  rounds: number;
  max_rounds: number;
  note?: string | null;
}

export interface NewSessionArgs {
  compare_group?: string;
  project_path: string;
  cwd?: string;
  worktree?: WorktreeRef;
  agent_id: string;
  model?: string | null;
  effort?: string | null;
  mode: PermissionMode;
  yolo?: boolean;
  parent_id?: string;
  title?: string;
}

export interface SessionPatch {
  title?: string;
  /** `null` clears the goal. */
  goal?: Goal | null;
  /** `null` wakes the session. */
  snoozed_until?: number | null;
  hidden?: boolean;
  archived?: boolean;
  pinned?: boolean;
  /** Opt-out of automatic settlement for this session. */
  settle_disabled?: boolean;
  agent_id?: string;
  /** `null` clears the model/effort override. */
  model?: string | null;
  effort?: string | null;
  mode?: PermissionMode;
  yolo?: boolean;
  cwd?: string;
  /** `null` detaches the session from its worktree. */
  worktree?: WorktreeRef | null;
}

export interface SendArgs {
  recover_context?: boolean;
  session_id: string;
  prompt: string;
  agent_id: string;
  model?: string | null;
  effort?: string | null;
  mode: PermissionMode;
  yolo?: boolean;
  /** First turn only: seed the prompt with another session's conversation. */
  context_from?: string;
  /** Other session ids whose digests ride along with this message (`@#` mentions). */
  references?: string[];
  attachments?: Attachment[];
}

export const chatCreateSession = (args: NewSessionArgs): Promise<SessionMeta> =>
  invoke("chat_create_session", { args });

export const chatListSessions = (): Promise<SessionMeta[]> => invoke("chat_list_sessions");

export const chatLoadTranscript = (sessionId: string): Promise<ChatEntry[]> =>
  invoke("chat_load_transcript", { sessionId });

/** Starts a turn; resolves with the turn id once the agent process is running.
 *  Progress arrives via `onChatEntry`. */
export const chatSend = (args: SendArgs): Promise<string> => invoke("chat_send", { args });

export const chatCancel = (sessionId: string, force = false): Promise<void> => invoke("chat_cancel", { sessionId, force });

export const chatUpdateSession = (sessionId: string, patch: SessionPatch): Promise<SessionMeta> =>
  invoke("chat_update_session", { sessionId, patch });

export const chatDeleteSession = (sessionId: string): Promise<void> =>
  invoke("chat_delete_session", { sessionId });
export const chatCancelSubagent = (sessionId: string, subagentId: string): Promise<void> =>
  invoke("chat_cancel_subagent", { sessionId, subagentId });
/** Branch a conversation up to a turn (or everything finished) into a new session. */
export const chatForkSession = (sessionId: string, uptoTurn?: string, keepWorktree = false, hidden = false): Promise<SessionMeta> =>
  invoke("chat_fork_session", { sessionId, uptoTurn: uptoTurn ?? null, keepWorktree, hidden });
/** Quit even though agents are still working (the user confirmed). */
export const forceQuit = (): Promise<void> => invoke("force_quit");
/** One finished turn: when, who, how many tokens and (if the agent reported it) what it cost. */
export interface UsageRow { ts: number; agent: string; model: string; project: string; session: string; input: number; output: number; cost: number | null }
export const usageRows = (days: number): Promise<UsageRow[]> => invoke("usage_rows", { days });
export interface UsageLimitEvent {
  ts: number;
  agent: string;
  project: string;
  session: string;
  session_title: string;
  title: string;
  message: string;
}
export const usageLimitEvents = (days: number): Promise<UsageLimitEvent[]> => invoke("usage_limit_events", { days });
export interface ProviderLimitWindow { label: string; used_percent: number; reset: string | null; reset_at?: number | null }
export interface ProviderLimits { provider: string; source: string; fetched_at: number; windows: ProviderLimitWindow[] }
export const providerUsageLimits = (provider: string): Promise<ProviderLimits> => invoke("provider_usage_limits", { provider });

/** Ask an agent for a fresh title for a conversation; resolves with the new title (already saved). */
export const regenerateSessionTitle = (sessionId: string, instructions?: string): Promise<string> => invoke("regenerate_session_title", { sessionId, instructions: instructions ?? null });
/** Restore a worktree to the snapshot taken before a turn. */
export const revertToCheckpoint = (sessionId: string, checkpoint: string): Promise<void> => invoke("revert_to_checkpoint", { sessionId, checkpoint });
export type GitTextKind = "commit" | "pr" | "branch";
/** Ask an installed headless agent to draft a commit message, PR title/body or branch name. */
export const generateGitText = (kind: GitTextKind, projectPath: string, instructions?: string): Promise<string> =>
  invoke("generate_git_text", { kind, projectPath, instructions: instructions ?? null });

/** A project file read for display: text (size-capped), or just its size when binary. */
export interface FilePreview { path: string; size: number; text: string | null; truncated: boolean; binary: boolean }
export const listWorkspaceDir = (root: string, dir: string): Promise<FileEntry[]> => invoke("list_workspace_dir", { root, dir });
export const readWorkspaceFile = (root: string, path: string): Promise<FilePreview> => invoke("read_workspace_file", { root, path });

/** Text and worksheet data extracted from a read-only Office document preview. */
export interface OfficeSheet { name: string; rows: string[][] }
export interface OfficePreview { kind: "docx" | "xlsx" | "pptx" | string; text: string; sheets: OfficeSheet[] }
export const readWorkspaceOffice = (root: string, path: string): Promise<OfficePreview> => invoke("read_workspace_office", { root, path });

/** One entry in a read-only ZIP archive listing. */
export interface ArchiveEntry { name: string; size: number; compressed: number; is_dir: boolean }
export const listWorkspaceArchive = (root: string, path: string): Promise<ArchiveEntry[]> => invoke("list_workspace_archive", { root, path });

/** Folder that holds the working directories of sessions started without a project. */
export const getScratchRoot = (): Promise<string> => invoke("get_scratch_root");
/** A fresh working folder for a project-less session, named from the prompt. */
export const createScratchDir = (hint: string): Promise<string> => invoke("create_scratch_dir", { hint });

/** Where a conversation's transcript file lives. */
export const chatTranscriptPath = (sessionId: string): Promise<string> => invoke("chat_transcript_path", { sessionId });

/** The pull request for a checkout's branch, from the optional `gh` CLI. */
export interface PrStatus {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  is_draft: boolean;
  review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | string;
  checks: { passing: number; failing: number; pending: number };
}
export const prStatus = (projectPath: string): Promise<PrStatus | null> => invoke("pr_status", { projectPath });

export interface PrCheck { name: string; status: string; conclusion: string; url: string | null }
export interface PrCommit { oid: string; headline: string; author: string; committed_at: string }
export interface PrFile { path: string; additions: number; deletions: number }
export interface PrTimelineItem { kind: "comment" | "review" | string; author: string; body: string; created_at: string; state: string; url: string | null }
export interface PrSummary {
  number: number;
  title: string;
  url: string;
  state: string;
  is_draft: boolean;
  review_decision: string;
  head_ref_name: string;
  base_ref_name: string;
  author: string;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  checks: { passing: number; failing: number; pending: number };
  labels: string[];
}
export interface PrDetail {
  summary: PrSummary;
  body: string;
  mergeable: string;
  merge_state_status: string;
  checks: PrCheck[];
  commits: PrCommit[];
  files: PrFile[];
  timeline: PrTimelineItem[];
  reviewers: string[];
}
export const listPullRequests = (projectPath: string, state: "open" | "closed" | "all" = "open"): Promise<PrSummary[]> =>
  invoke("list_pull_requests", { projectPath, state });
export const pullRequestDetail = (projectPath: string, number: number): Promise<PrDetail> =>
  invoke("pull_request_detail", { projectPath, number });

export interface PrFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  previous_filename: string | null;
  patch: string | null;
  diff: FileDiff | null;
}
export interface PrReviewComment {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  side: "LEFT" | "RIGHT" | string | null;
  body: string;
  author: string;
  created_at: string;
  url: string | null;
  in_reply_to_id: number | null;
  diff_hunk: string | null;
}
export interface PrFiles { files: PrFileEntry[]; comments: PrReviewComment[] }
export interface PrReviewGuideStop {
  title: string;
  summary: string;
  kind: string;
  path: string | null;
  line: number | null;
  excerpt: string | null;
}
export interface PrReviewGuide { title: string; summary: string; stops: PrReviewGuideStop[] }
export const generatePullRequestGuide = (projectPath: string, number: number): Promise<PrReviewGuide> =>
  invoke("generate_pull_request_guide", { projectPath, number });
export interface PendingReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  start_line?: number | null;
  start_side?: "LEFT" | "RIGHT" | null;
}
export interface PrReviewResult { id: number; url: string | null }
export const pullRequestFiles = (projectPath: string, number: number): Promise<PrFiles> =>
  invoke("pull_request_files", { projectPath, number });
export const submitPullRequestReview = (
  projectPath: string,
  number: number,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  body: string,
  comments: PendingReviewComment[],
): Promise<PrReviewResult> =>
  invoke("submit_pull_request_review", { projectPath, number, event, body, comments });
export const mergePullRequest = (projectPath: string, number: number, method: "squash" | "merge" | "rebase", deleteBranch = true): Promise<void> =>
  invoke("merge_pull_request", { projectPath, number, method, deleteBranch });
export const setPullRequestOpen = (projectPath: string, number: number, open: boolean): Promise<void> =>
  invoke("set_pull_request_open", { projectPath, number, open });
export const commentOnPullRequest = (projectPath: string, number: number, body: string): Promise<void> =>
  invoke("comment_on_pull_request", { projectPath, number, body });
export const updatePullRequest = (projectPath: string, number: number, title: string, body: string): Promise<void> =>
  invoke("update_pull_request", { projectPath, number, title, body });
export const setPullRequestDraft = (projectPath: string, number: number, draft: boolean): Promise<void> =>
  invoke("set_pull_request_draft", { projectPath, number, draft });
export const updatePullRequestBranch = (projectPath: string, number: number): Promise<void> =>
  invoke("update_pull_request_branch", { projectPath, number });
export const checkoutPullRequest = (projectPath: string, number: number): Promise<string> =>
  invoke("checkout_pull_request", { projectPath, number });
export const revertPullRequest = (projectPath: string, number: number, draft = false): Promise<{ number: number; url: string }> =>
  invoke("revert_pull_request", { projectPath, number, draft });
export const addPullRequestReviewers = (projectPath: string, number: number, reviewers: string[]): Promise<void> =>
  invoke("add_pull_request_reviewers", { projectPath, number, reviewers });
export const addPullRequestLabels = (projectPath: string, number: number, labels: string[]): Promise<void> =>
  invoke("add_pull_request_labels", { projectPath, number, labels });
export const reactToPullRequest = (projectPath: string, number: number, reaction: string): Promise<void> =>
  invoke("react_to_pull_request", { projectPath, number, reaction });
export const setPullRequestAutoMerge = (projectPath: string, number: number, method: "squash" | "merge" | "rebase"): Promise<void> =>
  invoke("set_pull_request_auto_merge", { projectPath, number, method });
export interface CreatedPullRequest { number: number; url: string }
export const createPullRequest = (projectPath: string, title: string, body: string, base: string, draft: boolean): Promise<CreatedPullRequest> =>
  invoke("create_pull_request", { projectPath, title, body, base, draft });
export const chatClearSession = (sessionId: string): Promise<{ session: SessionMeta; archived: SessionMeta | null }> =>
  invoke("chat_clear_session", { sessionId });

export interface ChatSearchHit {
  session_id: string;
  title: string;
  project_path: string;
  snippet: string;
  /** "user" | "assistant" */
  role: string;
  ts: number;
}

/** Store a pasted file (base64 body, no data: prefix) and get its attachment. */
export const savePastedAttachment = (dataBase64: string, ext: string): Promise<Attachment> =>
  invoke("save_attachment", { dataBase64, ext });

/** `data:` URL for a small image, or null. */
export const readImageThumbnail = (path: string): Promise<string | null> =>
  invoke("read_image_thumbnail", { path });

export interface AttachmentPreviewSource {
  path: string;
  kind: "image" | "video" | "audio" | "pdf" | "font";
  size: number;
}

/** Grant local streaming access to one validated attachment, including range requests. */
export const prepareAttachmentPreview = (path: string): Promise<AttachmentPreviewSource> =>
  invoke("prepare_attachment_preview", { path });

export const openAttachment = (path: string): Promise<void> => invoke("open_attachment", { path });

/** Native multi-file picker. */
/** An installed editor, IDE, terminal or the file manager that "Open in" can launch. */
export interface OpenInApp { id: string; name: string; kind: "editor" | "terminal" | "files" }
export const listOpenInApps = (): Promise<OpenInApp[]> => invoke("list_open_in_apps");
export const openInApp = (appId: string, path: string, line: number | null = null): Promise<void> =>
  invoke("open_in_app", { appId, path, line });

/** How agents and tools reach the network: the shell's proxy, a custom one, or none. */
export interface NetworkProxy { mode: "inherit" | "custom" | "off"; url: string; no_proxy: string }
export const setNetworkProxy = (config: NetworkProxy): Promise<NetworkProxy> => invoke("set_network_proxy", { config });
/** `config.url` is credential-masked; `effective` is the proxy children use (empty when direct). */
export const getNetworkProxy = (): Promise<{ config: NetworkProxy; effective: string }> => invoke("get_network_proxy");

export const saveTextFile = (defaultName: string, contents: string): Promise<string | null> =>
  invoke("save_text_file", { defaultName, contents });
/** Save a copy of a workspace file through the native save dialog. */
export const saveWorkspaceFileCopy = (root: string, path: string): Promise<string | null> =>
  invoke("save_workspace_file_copy", { root, path });
export const saveAttachmentCopy = (path: string, defaultName: string): Promise<string | null> =>
  invoke("save_attachment_copy", { path, defaultName });
export const pickFiles = (): Promise<Attachment[]> => invoke("pick_files");
/** Capture a window (macOS) or the primary screen and return the saved PNG path. */
export const captureScreenshot = (): Promise<string> => invoke("capture_screenshot");

export interface SnapshotInfo {
  path: string;
  app_name: string | null;
  window_title: string | null;
  app_text: string | null;
}
/** Capture a SnapShot plus best-effort app/window/accessibility metadata. */
export const captureSnapshot = (includeText: boolean): Promise<SnapshotInfo> =>
  invoke("capture_snapshot", { includeText });

export const chatSearch = (query: string, limit: number): Promise<ChatSearchHit[]> =>
  invoke("chat_search", { query, limit });

/** A CLI session on disk that can be imported as a FlipFlopper session. */
export interface ImportCandidate {
  agent_id: string;
  native_id: string;
  path: string;
  cwd: string;
  title: string;
  updated_at: number;
  size: number;
}

export const chatImportScan = (projectPaths: string[]): Promise<ImportCandidate[]> =>
  invoke("chat_import_scan", { projectPaths });

export const chatImport = (requests: Omit<ImportCandidate, "size">[]): Promise<SessionMeta[]> =>
  invoke("chat_import", { requests });

export const onChatEntry = (sessionId: string, cb: (entry: ChatEntry) => void): Promise<UnlistenFn> =>
  listen<ChatEntry>(`chat://${sessionId}`, (e) => cb(e.payload));

// ── Native menu ──────────────────────────────────────────────────────────────

export interface NativeMenuState {
  hasProject: boolean;
  hasSession: boolean;
  running: boolean;
  fullAccess: boolean;
  sidebarOpen: boolean;
  sidePaneOpen: boolean;
  sideTab: "changes" | "preview" | "terminal" | "flow" | "explain" | "files" | "pulls" | "sidechat";
}

export const syncNativeMenuState = (state: NativeMenuState): Promise<void> =>
  invoke("sync_native_menu_state", { state });

export const windowTitlebarDoubleClick = (): Promise<void> =>
  invoke("window_titlebar_double_click");

export const onNativeMenuCommand = (cb: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>("native-menu-command", (e) => cb(e.payload));

export const chatOpenTerminal = (sessionId: string): Promise<string> => invoke("chat_open_terminal", { sessionId });
export const chatCloseTerminal = (sessionId: string): Promise<void> => invoke("chat_close_terminal", { sessionId });
export const chatDetachNative = (sessionId: string): Promise<void> => invoke("chat_detach_native", { sessionId });
/** Start a fresh agent conversation on the next message while keeping the visible transcript. */
export const chatRestartSession = (sessionId: string): Promise<SessionMeta> => invoke("chat_restart_session", { sessionId });
export const chatRuntimeState = (sessionId: string): Promise<AgentRuntimeState> => invoke("chat_runtime_state", { sessionId });
export const chatSetMode = (sessionId: string, mode: PermissionMode, yolo: boolean): Promise<{ session: SessionMeta; runtime: AgentRuntimeState }> =>
  invoke("chat_set_mode", { sessionId, mode, yolo });
export const chatRespond = (sessionId: string, turnId: string, requestId: string, response: InteractionResponse): Promise<void> =>
  invoke("chat_respond", { sessionId, turnId, requestId, response });
export const agentRuntimeInfo = (agentId: string): Promise<AgentRuntimeInfo> => invoke("agent_runtime_info", { agentId });


export interface AndroidCliInfo {
  version: string | null;
  previews: boolean;
  inspect: boolean;
  modules: string[];
  error: string | null;
}
export interface AndroidPreviewFunction { methodFqn: string; name?: string; group?: string }
export interface AndroidCliResult {
  previews?: AndroidPreviewFunction[];
  artifacts?: Attachment[];
  context?: { checkout: string; device: string; target: string; preview: string; capture_started_ms: number; capture_finished_ms: number; data: unknown };
}
export const androidCliInfo = (projectPath: string): Promise<AndroidCliInfo> => invoke("android_cli_info", { projectPath });
export const androidCliBegin = (): Promise<string> => invoke("android_cli_begin");
export const androidCliCancel = (id: string): Promise<void> => invoke("android_cli_cancel", { id });
export const androidCliRun = (id: string, projectPath: string, action: "list" | "render" | "inspect", target = "", fqn = "", serial = ""): Promise<AndroidCliResult> =>
  invoke("android_cli_run", { id, projectPath, action, target, fqn, serial });
