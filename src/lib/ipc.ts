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

// ── Agents ───────────────────────────────────────────────────────────────────

export const getAgents = (includeVersions = true): Promise<AgentInfo[]> =>
  invoke("get_agents", { includeVersions });

// ── Project ──────────────────────────────────────────────────────────────────

export const openProject = (path: string): Promise<ProjectInfo> =>
  invoke("open_project", { path });

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

export const listPromptSkills = (projectPath: string | null): Promise<PromptSkill[]> =>
  invoke("list_prompt_skills", { projectPath });

export const pickProjectFolder = (): Promise<string | null> =>
  invoke("pick_project_folder");

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
export const listOllamaModels = (): Promise<string[]> => invoke("list_ollama_models");

export const generateCommitMessage = (projectPath: string, agentId: string): Promise<string> =>
  invoke("generate_commit_message", { projectPath, agentId });

export const createWorktree = (projectPath: string, agentId: string): Promise<WorktreeInfo> =>
  invoke("create_worktree", { projectPath, agentId });

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

export type PermissionMode = "manual" | "auto_edit" | "plan" | "ask" | "full";
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
  connected: boolean; active_turn_id?: string | null; agent_id: string; native_session_id: string | null; agent_version: string | null;
  capabilities: Record<string, unknown> | null; config_options: AgentOption[];
  modes: { id: string; name: string; description?: string }[];
  current_mode: string | null; commands: { name: string; description: string }[]; pending: AgentInteraction[];
  permission_mode?: PermissionMode | null;
}
export interface AgentRuntimeInfo { available: boolean; detail: string; protocol: string; node_version: string | null; helper_version: string | null }

export type ChatEvent =
  | { type: "turn_started"; turn_id: string; agent_id: string }
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
  native_ids: Record<string, string>;
  acp_sessions?: Record<string, { session_id: string; cwd: string }>;
  entry_count: number;
  /** "idle" | "running" | "error" */
  status: string;
  archived: boolean;
  pinned: boolean;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewSessionArgs {
  project_path: string;
  cwd?: string;
  worktree?: WorktreeRef;
  agent_id: string;
  model?: string | null;
  effort?: string | null;
  mode: PermissionMode;
  parent_id?: string;
  title?: string;
}

export interface SessionPatch {
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  agent_id?: string;
  /** `null` clears the model/effort override. */
  model?: string | null;
  effort?: string | null;
  mode?: PermissionMode;
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
  /** First turn only: seed the prompt with another session's conversation. */
  context_from?: string;
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
  kind: "image" | "video" | "audio" | "pdf";
  size: number;
}

/** Grant local streaming access to one validated attachment, including range requests. */
export const prepareAttachmentPreview = (path: string): Promise<AttachmentPreviewSource> =>
  invoke("prepare_attachment_preview", { path });

export const openAttachment = (path: string): Promise<void> => invoke("open_attachment", { path });

/** Native multi-file picker. */
export const pickFiles = (): Promise<Attachment[]> => invoke("pick_files");

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
  sideTab: "changes" | "preview" | "terminal" | "flow" | "explain";
}

export const syncNativeMenuState = (state: NativeMenuState): Promise<void> =>
  invoke("sync_native_menu_state", { state });

export const windowTitlebarDoubleClick = (): Promise<void> =>
  invoke("window_titlebar_double_click");

export const onNativeMenuCommand = (cb: (id: string) => void): Promise<UnlistenFn> =>
  listen<string>("native-menu-command", (e) => cb(e.payload));

export const chatDetachNative = (sessionId: string): Promise<void> => invoke("chat_detach_native", { sessionId });
export const chatRuntimeState = (sessionId: string): Promise<AgentRuntimeState> => invoke("chat_runtime_state", { sessionId });
export const chatSetMode = (sessionId: string, mode: PermissionMode): Promise<{ session: SessionMeta; runtime: AgentRuntimeState }> =>
  invoke("chat_set_mode", { sessionId, mode });
export const chatRespond = (sessionId: string, turnId: string, requestId: string, response: InteractionResponse): Promise<void> =>
  invoke("chat_respond", { sessionId, turnId, requestId, response });
export const agentRuntimeInfo = (agentId: string): Promise<AgentRuntimeInfo> => invoke("agent_runtime_info", { agentId });
