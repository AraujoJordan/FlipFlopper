/** Remove worktrees belonging to archived sessions that have been idle for `days`.
 *  Shared checkouts and worktrees with local changes (unless `discardDirty`) are kept;
 *  branches and conversations always survive, and each cleaned session returns to the
 *  project checkout. Shared by the manual Settings action and the post-settle timer. */
import { chat, setChat } from "./chat";
import { chatUpdateSession, getWorktreeStatus, removeWorktree } from "./ipc";

export interface WorktreeCleanupResult {
  removed: number;
  kept: number;
  failed: number;
  candidates: number;
}

export async function cleanupArchivedWorktrees(
  days: number,
  discardDirty = false,
  now = Date.now(),
): Promise<WorktreeCleanupResult> {
  const cutoff = now - Math.max(1, days) * 86_400_000;
  const candidates = chat.sessions.filter((session) => session.archived && session.worktree && session.updated_at < cutoff);
  const candidateIds = new Set(candidates.map((session) => session.id));
  // A worktree still used by another conversation (e.g. a shared checkout) must stay.
  const inUse = new Set(chat.sessions
    .filter((session) => !candidateIds.has(session.id) && session.worktree)
    .map((session) => session.worktree!.path));
  let removed = 0, kept = 0, failed = 0;
  for (const session of candidates) {
    const tree = session.worktree!;
    try {
      if (inUse.has(tree.path)) { kept++; continue; }
      if (!discardDirty) {
        const status = await getWorktreeStatus(tree.path, tree.source_branch).catch(() => null);
        if (!status || status.dirty) { kept++; continue; }
      }
      await removeWorktree(session.project_path, tree.path, tree.branch, false);
      const meta = await chatUpdateSession(session.id, { worktree: null, cwd: session.project_path });
      setChat("sessions", (existing) => existing.id === session.id, meta);
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, kept, failed, candidates: candidates.length };
}
