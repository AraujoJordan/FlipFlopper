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
}

export interface SessionInfo {
  id: string;
  agent_id: string;
  project_path: string;
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

export interface FileStatus {
  path: string;
  status: string;
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

// ── PTY ──────────────────────────────────────────────────────────────────────

export const spawnAgent = (agentId: string, projectPath: string): Promise<string> =>
  invoke("spawn_agent", { agentId, projectPath });

export const ptyInput = (sessionId: string, data: string): Promise<void> =>
  invoke("pty_input", { sessionId, data });

export const ptyResize = (sessionId: string, cols: number, rows: number): Promise<void> =>
  invoke("pty_resize", { sessionId, cols, rows });

export const ptyKill = (sessionId: string): Promise<void> =>
  invoke("pty_kill", { sessionId });

export const listSessions = (): Promise<SessionInfo[]> =>
  invoke("list_sessions");

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

export const injectFileRefs = (sessionId: string, paths: string[]): Promise<void> =>
  invoke("inject_file_refs", { sessionId, paths });

export const pickProjectFolder = (): Promise<string | null> =>
  invoke("pick_project_folder");

export const pickPromptFile = (projectPath: string | null, imageOnly = false): Promise<string | null> =>
  invoke("pick_prompt_file", { projectPath, imageOnly });

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

// ── Git ──────────────────────────────────────────────────────────────────────

export const getGitStatus = (projectPath: string): Promise<FileStatus[]> =>
  invoke("get_git_status", { projectPath });

export const autoCommit = (projectPath: string, message: string): Promise<CommitResult> =>
  invoke("auto_commit", { projectPath, message });

export const ensureWorkBranch = (projectPath: string, branch: string): Promise<string> =>
  invoke("ensure_work_branch", { projectPath, branch });

export const getCurrentBranch = (projectPath: string): Promise<string> =>
  invoke("get_current_branch", { projectPath });

export const getGitLog = (projectPath: string, limit: number): Promise<CommitEntry[]> =>
  invoke("get_git_log", { projectPath, limit });

export const gitRollback = (projectPath: string, sha: string): Promise<void> =>
  invoke("git_rollback", { projectPath, sha });

export const renameCommit = (projectPath: string, sha: string, message: string): Promise<void> =>
  invoke("rename_commit", { projectPath, sha, message });

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
 *  `path` optionally scopes to one file (relative to project root). */
export const getReviewDiff = (
  projectPath: string,
  rev?: string,
  path?: string,
): Promise<FileDiff[]> =>
  invoke("get_review_diff", { projectPath, rev: rev ?? null, path: path ?? null });

// ── Tools ────────────────────────────────────────────────────────────────────

export const getToolCatalog = (): Promise<ToolInfo[]> =>
  invoke("get_tool_catalog");

export const installTool = (toolId: string, projectPath: string): Promise<string> =>
  invoke("install_tool", { toolId, projectPath });

// ── Handoff ──────────────────────────────────────────────────────────────────

export const continueAgent = (projectPath: string, fromAgent: string, toAgent: string): Promise<string> =>
  invoke("continue_agent", { projectPath, fromAgent, toAgent });
