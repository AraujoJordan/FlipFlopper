import { Component, Show, createSignal } from "solid-js";
import {
  activeWorktree, bumpFileTree, bumpGitStatus, closeAllEditorFiles, registerWorktreeCloseInterceptor,
  removeTab, store, type Tab,
} from "../../lib/store";
import {
  commitWorktree, generateWorktreeCommitMessage, getCurrentBranch, getWorktreeStatus,
  lspShutdownProject, mergeWorktreeBranch, ptyKill, removeWorktree,
} from "../../lib/ipc";
import { isProtectedBranch } from "../../lib/constants";
import { Button, Spinner, confirmDialog, toast } from "../ui";
import { openConflictDialog } from "./ConflictFixDialog";
import { cancelPendingWorktreeNodeRemoval } from "../../lib/orchestrator";

interface DialogState { tab: Tab; target: string; }
const [state, setState] = createSignal<DialogState | null>(null);
const [busy, setBusy] = createSignal(false);
const [generating, setGenerating] = createSignal(false);
const [message, setMessage] = createSignal("");
const [error, setError] = createSignal<string | null>(null);

async function kill(sessionId: string) {
  try { await ptyKill(sessionId); } catch { /* already exited */ }
}

async function closeEditorsIfActive(tab: Tab) {
  if (store.activeTabId === tab.sessionId && activeWorktree()) await closeAllEditorFiles();
}

async function cleanup(tab: Tab, deleteBranch: boolean) {
  const project = store.currentProject;
  const wt = tab.worktree;
  if (!project || !wt) return;
  await closeEditorsIfActive(tab);
  await kill(tab.sessionId);
  await removeWorktree(project.path, wt.path, wt.branch, deleteBranch);
  await lspShutdownProject(wt.path).catch(() => {});
  removeTab(tab.sessionId, { force: true });
}

export async function openWorktreeCloseDialog(tab: Tab) {
  const project = store.currentProject;
  const wt = tab.worktree;
  if (!project || !wt) return;
  try {
    const status = await getWorktreeStatus(wt.path, wt.sourceBranch);
    if (!status.exists || (!status.dirty && status.commits_ahead === 0)) {
      await cleanup(tab, true);
      toast(status.exists ? "Clean worktree removed" : "Missing worktree cleaned up", "success");
      return;
    }
    const target = await getCurrentBranch(project.path);
    setState({ tab, target });
    setError(null);
    setMessage(`Agent work on ${wt.branch}`);
    setGenerating(true);
    void generateWorktreeCommitMessage(wt.path, wt.sourceBranch, tab.agentId)
      .then(setMessage)
      .catch(() => {})
      .finally(() => setGenerating(false));
  } catch (e) {
    toast(`Could not inspect worktree: ${String(e)}`, "error");
  }
}

registerWorktreeCloseInterceptor((tab) => { void openWorktreeCloseDialog(tab); });

export const WorktreeCloseDialogHost: Component = () => {
  const close = () => {
    if (busy()) return;
    const sessionId = state()?.tab.sessionId;
    if (sessionId) cancelPendingWorktreeNodeRemoval(sessionId);
    setState(null);
  };

  async function mergeBack() {
    const s = state();
    const project = store.currentProject;
    const wt = s?.tab.worktree;
    if (!s || !project || !wt) return;
    if (isProtectedBranch(s.target)) {
      const confirmed = await confirmDialog(`Merge ${wt.branch} into protected branch ${s.target}?`, "Merge");
      if (!confirmed) return;
    }
    setBusy(true); setError(null);
    try {
      await closeEditorsIfActive(s.tab);
      await kill(s.tab.sessionId);
      await commitWorktree(wt.path, message().trim() || `Agent work on ${wt.branch}`);
      const outcome = await mergeWorktreeBranch(project.path, wt.branch);
      await removeWorktree(project.path, wt.path, wt.branch, !outcome.conflicted);
      await lspShutdownProject(wt.path).catch(() => {});
      removeTab(s.tab.sessionId, { force: true });
      bumpGitStatus(); bumpFileTree();
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
    try { await cleanup(s.tab, true); setState(null); toast("Worktree discarded", "success"); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function keep() {
    const s = state(); const wt = s?.tab.worktree; if (!s || !wt) return;
    setBusy(true);
    try {
      await closeEditorsIfActive(s.tab); await kill(s.tab.sessionId);
      await lspShutdownProject(wt.path).catch(() => {});
      removeTab(s.tab.sessionId, { force: true }); setState(null);
      toast(`Worktree kept at ${wt.path}`, "info");
    } finally { setBusy(false); }
  }

  return <Show when={state()}>{(s) => <div class="overlay-backdrop-in" onclick={close} style={{ position: "fixed", inset: 0, "z-index": "var(--z-dialog)", display: "flex", "align-items": "center", "justify-content": "center", background: "rgba(0,0,0,.5)" }}>
    <div class="overlay-pop-in" onclick={(e) => e.stopPropagation()} style={{ width: "440px", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)", padding: "18px" }}>
      <div style={{ "font-size": "13.5px", color: "var(--fg-default)", "font-weight": "600", "margin-bottom": "7px" }}>Close isolated agent</div>
      <div style={{ "font-family": "var(--font-mono)", "font-size": "11px", color: "var(--fg-muted)", "margin-bottom": "12px" }}>{s().tab.worktree!.branch} → {s().target}</div>
      <Show when={s().target !== s().tab.worktree!.sourceBranch}><div style={{ color: "var(--warning)", "font-size": "11px", "margin-bottom": "10px" }}>The main checkout moved from {s().tab.worktree!.sourceBranch} to {s().target}; merge will target the current branch.</div></Show>
      <label style={{ display: "block", "font-size": "11px", color: "var(--fg-subtle)", "margin-bottom": "5px" }}>Commit message {generating() ? "(generating…)" : ""}</label>
      <input value={message()} oninput={(e) => setMessage(e.currentTarget.value)} disabled={busy()} style={{ width: "100%", padding: "7px 9px", background: "var(--surface-1)", color: "var(--fg-default)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-md)", "font-size": "12px", "box-sizing": "border-box", "margin-bottom": "10px" }} />
      <Show when={error()}><div style={{ color: "var(--danger)", "font-size": "11px", "white-space": "pre-wrap", "margin-bottom": "10px" }}>{error()}</div></Show>
      <div style={{ display: "flex", gap: "7px", "justify-content": "flex-end", "flex-wrap": "wrap" }}>
        <Button variant="ghost" onClick={close} disabled={busy()}>Cancel</Button>
        <Button variant="ghost" onClick={keep} disabled={busy()}>Keep worktree</Button>
        <Button variant="danger" onClick={discard} disabled={busy()}>Discard</Button>
        <Button variant="solid" onClick={mergeBack} disabled={busy() || generating()}><Show when={busy()}><Spinner size={12} /></Show>Merge into {s().target}</Button>
      </div>
    </div>
  </div>}</Show>;
};
