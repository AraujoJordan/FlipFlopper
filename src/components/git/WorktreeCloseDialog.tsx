import { RetainedPresence } from "../ui";
import { Component, Show, createSignal } from "solid-js";
import { bumpGitStatus } from "../../lib/store";
import { cancelSession, chat, detachWorktree } from "../../lib/chat";
import {
  commitWorktree, generateWorktreeCommitMessage, getCurrentBranch, getWorktreeStatus,
  mergeWorktreeBranch, removeWorktree, type SessionMeta,
} from "../../lib/ipc";
import { isProtectedBranch } from "../../lib/constants";
import { Button, Spinner, confirmDialog, toast } from "../ui";
import { openConflictDialog } from "./ConflictFixDialog";

interface DialogState { session: SessionMeta; target: string; }
const [state, setState] = createSignal<DialogState | null>(null);
const [busy, setBusy] = createSignal(false);
const [generating, setGenerating] = createSignal(false);
const [message, setMessage] = createSignal("");
const [error, setError] = createSignal<string | null>(null);

async function removeAndDetach(session: SessionMeta, deleteBranch: boolean) {
  const wt = session.worktree;
  if (!wt) return;
  await removeWorktree(session.project_path, wt.path, wt.branch, deleteBranch);
  await detachWorktree(session.id);
}

/** Merge-back / discard flow for a session running in an isolated worktree.
 *  A clean worktree is just removed. */
export async function openWorktreeDialog(sessionId: string) {
  const session = chat.sessions.find((s) => s.id === sessionId);
  const wt = session?.worktree;
  if (!session || !wt) return;
  try {
    const status = await getWorktreeStatus(wt.path, wt.source_branch);
    if (!status.exists || (!status.dirty && status.commits_ahead === 0)) {
      await cancelSession(session.id, true);
      await removeAndDetach(session, true);
      toast(status.exists ? "Clean worktree removed" : "Missing worktree cleaned up", "success");
      return;
    }
    const target = await getCurrentBranch(session.project_path);
    setState({ session, target });
    setError(null);
    setMessage(`Agent work on ${wt.branch}`);
    setGenerating(true);
    void generateWorktreeCommitMessage(wt.path, wt.source_branch, session.agent_id)
      .then(setMessage)
      .catch(() => {})
      .finally(() => setGenerating(false));
  } catch (e) {
    toast(`Could not inspect worktree: ${String(e)}`, "error");
  }
}

export const WorktreeCloseDialogHost: Component = () => {
  const close = () => {
    if (!busy()) setState(null);
  };

  async function mergeBack() {
    const s = state();
    const wt = s?.session.worktree;
    if (!s || !wt) return;
    if (isProtectedBranch(s.target)) {
      const confirmed = await confirmDialog(`Merge ${wt.branch} into protected branch ${s.target}?`, "Merge");
      if (!confirmed) return;
    }
    setBusy(true); setError(null);
    try {
      await cancelSession(s.session.id, true);
      await commitWorktree(wt.path, message().trim() || `Agent work on ${wt.branch}`);
      const outcome = await mergeWorktreeBranch(s.session.project_path, wt.branch);
      await removeAndDetach(s.session, !outcome.conflicted);
      bumpGitStatus();
      setState(null);
      if (outcome.conflicted) {
        openConflictDialog(outcome.conflicted_paths, `Merging agent worktree branch ${wt.branch} into ${s.target}`);
      } else {
        toast(`Merged ${wt.branch} into ${s.target}`, "success");
      }
    } catch (e) {
      setError(String(e));
    } finally { setBusy(false); }
  }

  async function discard() {
    const s = state(); if (!s) return;
    if (!await confirmDialog("Discard all changes in this isolated worktree?", "Discard")) return;
    setBusy(true);
    try {
      await cancelSession(s.session.id, true);
      await removeAndDetach(s.session, true);
      setState(null);
      toast("Worktree discarded", "success");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  return <RetainedPresence value={state()}>{(s) => <div class="overlay-backdrop-in" onclick={close} style={{ position: "fixed", inset: 0, "z-index": "var(--z-dialog)", display: "flex", "align-items": "center", "justify-content": "center", background: "rgba(0,0,0,.5)" }}>
    <div class="overlay-pop-in" onclick={(e) => e.stopPropagation()} style={{ width: "440px", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)", padding: "18px" }}>
      <div style={{ "font-size": "13.5px", color: "var(--fg-default)", "font-weight": "600", "margin-bottom": "7px" }}>Merge isolated work</div>
      <div style={{ "font-family": "var(--font-mono)", "font-size": "11px", color: "var(--fg-muted)", "margin-bottom": "12px" }}>{s().session.worktree!.branch} → {s().target}</div>
      <Show when={s().target !== s().session.worktree!.source_branch}><div style={{ color: "var(--status-mod)", "font-size": "11px", "margin-bottom": "10px" }}>The main checkout moved from {s().session.worktree!.source_branch} to {s().target}; merge will target the current branch.</div></Show>
      <label style={{ display: "block", "font-size": "11px", color: "var(--fg-subtle)", "margin-bottom": "5px" }}>Commit message {generating() ? "(generating…)" : ""}</label>
      <input value={message()} oninput={(e) => setMessage(e.currentTarget.value)} disabled={busy()} style={{ width: "100%", padding: "7px 9px", background: "var(--surface-1)", color: "var(--fg-default)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-md)", "font-size": "12px", "box-sizing": "border-box", "margin-bottom": "10px" }} />
      <Show when={error()}><div style={{ color: "var(--status-del)", "font-size": "11px", "white-space": "pre-wrap", "margin-bottom": "10px" }}>{error()}</div></Show>
      <div style={{ display: "flex", gap: "7px", "justify-content": "flex-end", "flex-wrap": "wrap" }}>
        <Button variant="ghost" onClick={close} disabled={busy()}>Cancel</Button>
        <Button variant="danger" onClick={discard} disabled={busy()}>Discard</Button>
        <Button variant="solid" onClick={mergeBack} disabled={busy() || generating()}><Show when={busy()}><Spinner size={12} /></Show>Merge into {s().target}</Button>
      </div>
    </div>
  </div>}</RetainedPresence>;
};
