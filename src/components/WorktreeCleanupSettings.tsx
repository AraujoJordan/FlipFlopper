import { Component, For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { chat, setChat } from "../lib/chat";
import { bumpGitStatus, store } from "../lib/store";
import { chatUpdateSession, listWorktrees, removeWorktree, type ManagedWorktree } from "../lib/ipc";
import { Checkbox, Spinner, toast } from "./ui";
import { Icon } from "./shell/Icon";

const AGES = [7, 30, 90] as const;

/** Settings → Worktrees: remove worktrees owned by archived sessions that have
 *  been idle for a while. Dirty worktrees are skipped unless forced; branches
 *  are kept and the session falls back to the project checkout. */
const WorktreeCleanupSettings: Component = () => {
  const [days, setDays] = createSignal<(typeof AGES)[number]>(30);
  const [discard, setDiscard] = createSignal(false);
  const [entries, setEntries] = createSignal<ManagedWorktree[] | "loading" | "error">("loading");
  const [busy, setBusy] = createSignal(false);
  const [lastResult, setLastResult] = createSignal<string | null>(null);
  const projectPath = () => store.currentProject?.path ?? null;

  async function load() {
    const path = projectPath();
    if (!path) { setEntries([]); return; }
    setEntries("loading");
    try { setEntries(await listWorktrees(path)); }
    catch { setEntries("error"); }
  }
  createEffect(on(projectPath, () => { void load(); }, { defer: true }));

  const candidates = createMemo(() => {
    const path = projectPath();
    if (!path || !Array.isArray(entries())) return [];
    const cutoff = Date.now() - days() * 86_400_000;
    const inUse = new Set(chat.sessions.filter((session) => !session.archived && !session.hidden && session.worktree).map((session) => session.worktree!.path));
    const byPath = new Map((entries() as ManagedWorktree[]).map((entry) => [entry.path, entry]));
    return chat.sessions
      .filter((session) => session.archived && !session.hidden && session.project_path === path && session.worktree && session.updated_at <= cutoff)
      .map((session) => ({ session, worktree: session.worktree!, info: byPath.get(session.worktree!.path) }))
      .filter((entry) => !!entry.info && !inUse.has(entry.info.path));
  });
  const dirty = () => candidates().filter((entry) => entry.info!.dirty);
  const removable = () => candidates().filter((entry) => discard() || !entry.info!.dirty);

  async function clean() {
    const targets = removable();
    if (!targets.length || busy()) return;
    setBusy(true);
    let removed = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        await removeWorktree(target.session.project_path, target.worktree.path, target.worktree.branch, false);
        const meta = await chatUpdateSession(target.session.id, { worktree: null, cwd: target.session.project_path });
        setChat("sessions", (session) => session.id === target.session.id, meta);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    await load();
    bumpGitStatus();
    setLastResult(`${removed} worktree${removed === 1 ? "" : "s"} removed${failed ? `, ${failed} failed` : ""}${dirty().length && !discard() ? ` · ${dirty().length} dirty skipped` : ""}.`);
    toast(`Worktree cleanup: ${removed} removed${failed ? `, ${failed} failed` : ""}`, failed ? "error" : "success");
    setBusy(false);
  }

  return (
    <div class="worktree-cleanup">
      <div class="worktree-cleanup-controls">
        <label class="worktree-cleanup-age">
          <span>Idle for</span>
          <select class="ui-field" aria-label="Idle days before cleanup" value={String(days())} onChange={(event) => setDays(Number(event.currentTarget.value) as (typeof AGES)[number])}>
            <For each={AGES}>{(age) => <option value={String(age)}>{age} days</option>}</For>
          </select>
        </label>
        <Checkbox checked={discard()} onChange={setDiscard} label="Discard local changes" />
        <button type="button" class="ui-btn ui-btn-outline" disabled={!removable().length || busy()} onClick={() => void clean()}>
          <Show when={busy()} fallback={<><Icon name="trash" size={13} /> Remove {removable().length || ""}</>}><Spinner size={12} /> Removing…</Show>
        </button>
      </div>
      <div class="worktree-cleanup-hint">
        Only archived sessions in this project are considered; worktrees still used by an active session are skipped. Branches are kept, so merged work stays recoverable.
      </div>
      <Show when={entries() === "loading"}><div class="worktree-cleanup-note"><Spinner size={12} /> Reading worktrees…</div></Show>
      <Show when={entries() === "error"}><div class="worktree-cleanup-note" role="alert">Couldn't read this project's worktrees.</div></Show>
      <Show when={Array.isArray(entries()) && candidates().length > 0}>
        <div class="worktree-cleanup-list">
          <For each={candidates()}>
            {(entry) => (
              <div class="worktree-cleanup-row">
                <Icon name="gitBranch" size={13} />
                <span class="worktree-cleanup-branch">{entry.worktree.branch.replace(/^flipflopper\//, "")}</span>
                <span class="worktree-cleanup-title" title={entry.session.title}>{entry.session.title || "Archived session"}</span>
                <Show when={entry.info!.dirty}><span class="worktree-cleanup-dirty">local changes</span></Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={Array.isArray(entries()) && candidates().length === 0 && entries() !== "loading"}>
        <div class="worktree-cleanup-note">No archived-session worktrees are old enough to remove.</div>
      </Show>
      <Show when={lastResult()}>{(result) => <div class="worktree-cleanup-note">{result()}</div>}</Show>
    </div>
  );
};

export default WorktreeCleanupSettings;
