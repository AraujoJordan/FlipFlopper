import { Component, For, Show, createEffect, createMemo, createSignal, lazy, on, onCleanup } from "solid-js";
import { bumpGitStatus, closeReview, effectiveRoot, isFileViewed, openReview, setGitPanelTab, store, type DiffSource } from "../../lib/store";
import { gitChangedCount, gitLoading, gitStatus, gitSync, gitTick } from "../../lib/gitStatus";
import { gitListBranches, gitStage, gitUnstage, getGitLog, triggerHaptic, type BranchInfo, type CommitEntry } from "../../lib/ipc";
import { activeSession, chat } from "../../lib/chat";
import { openWorktreeDialog } from "../git/WorktreeCloseDialog";
import { Icon } from "../shell/Icon";
import { toast, useValueMotion, useSelectionMotion } from "../ui";
import SyncHeader from "../git/SyncHeader";
import ChangesTab from "../git/ChangesTab";
import HistoryTab from "../git/HistoryTab";
// Lazy: keeps highlight.js out of the startup bundle until a diff is opened.
const DiffPane = lazy(() => import("../DiffPane"));

function basename(p: string): string {
  return p.split("/").pop() || p;
}

/** Source control for the active checkout: sync bar, working-tree changes and
 *  history. Selecting a file or commit drills into its diff (DiffPane) with a
 *  back button. */
const ChangesView: Component = () => {
  let view: HTMLDivElement | undefined;
  useValueMotion(() => view?.querySelector<HTMLElement>(".changes-diff-body, .changes-tabs") ?? undefined, () => `${store.review?.rev ?? ""}:${store.review?.path ?? ""}:${store.gitPanelTab}`);
  useSelectionMotion(() => view, () => store.gitPanelTab, ".changes-tab-on", true);

  const [branches, setBranches] = createSignal<BranchInfo[]>([]);
  const [commits, setCommits] = createSignal<CommitEntry[]>([]);
  const [baseRef, setBaseRef] = createSignal("");
  const [commitSha, setCommitSha] = createSignal("");
  const [hideTests, setHideTests] = createSignal(false);

  const defaultBaseRef = (list: BranchInfo[]) => {
    const names = list.map((branch) => branch.remote_ref ?? branch.name);
    return ["origin/main", "main", "origin/master", "master"].find((name) => names.includes(name))
      ?? names.find((name) => name !== store.currentBranch)
      ?? "main";
  };

  createEffect(on(() => store.currentProject?.path, () => { setBaseRef(""); setCommitSha(""); }));
  createEffect(on(() => effectiveRoot(), (root) => {
    if (!root) { setBranches([]); setCommits([]); return; }
    let cancelled = false;
    void gitListBranches(root).then((list) => {
      if (cancelled) return;
      setBranches(list);
      if (!baseRef()) setBaseRef(defaultBaseRef(list));
    }).catch(() => { if (!cancelled) setBranches([]); });
    void getGitLog(root, 20).then((list) => {
      if (cancelled) return;
      setCommits(list);
      if (!commitSha() && list[0]) setCommitSha(list[0].sha);
    }).catch(() => { if (!cancelled) setCommits([]); });
    onCleanup(() => { cancelled = true; });
  }));

  const sourceMode = createMemo<DiffSource>(() => {
    const review = store.review;
    if (!review) return "working";
    if (review.source) return review.source;
    if (review.turnFiles?.length) return "turn";
    if (review.rev?.includes("...")) return "branch";
    if (review.rev?.includes("~1..")) return "commit";
    return "working";
  });

  createEffect(() => {
    const review = store.review;
    setHideTests(review?.hideTests ?? false);
    if (review?.baseRef) setBaseRef(review.baseRef);
    if (review?.rev?.includes("...")) setBaseRef(review.rev.split("...")[0] ?? "");
    if (review?.rev?.includes("~1..")) setCommitSha(review.rev.split("~1..")[0] ?? "");
  });

  const latestTurn = createMemo(() => {
    const id = chat.activeId;
    const sessionView = id ? chat.views[id] : undefined;
    if (!sessionView) return null;
    for (let i = sessionView.messages.length - 1; i >= 0; i--) {
      const message = sessionView.messages[i];
      if (message.role === "assistant" && message.status !== "running" && message.changedFiles.length > 0) {
        return { id: message.id, files: message.changedFiles.map((file) => file.path) };
      }
    }
    return null;
  });

  function chooseSource(source: DiffSource) {
    const keep = { source, hideTests: hideTests() };
    if (source === "turn") {
      const turn = latestTurn();
      if (!turn) { toast("No completed turn with changed files yet.", "info"); return; }
      openReview(undefined, "Turn changes", undefined, undefined, turn.files, keep);
      return;
    }
    if (source === "branch") {
      const base = baseRef().trim();
      if (!base) { toast("Choose a base ref first.", "info"); return; }
      openReview(`${base}...HEAD`, `Branch changes · ${base}`, undefined, undefined, undefined, { ...keep, baseRef: base });
      return;
    }
    if (source === "commit") {
      const selected = commits().find((commit) => commit.sha === commitSha());
      if (!selected) { toast("Choose a commit first.", "info"); return; }
      openReview(`${selected.sha}~1..${selected.sha}`, selected.short_sha, undefined, undefined, undefined, keep);
      return;
    }
    openReview(undefined, "Working changes", undefined, undefined, undefined, keep);
  }

  function toggleHideTests() {
    setHideTests((hidden) => !hidden);
    chooseSource(sourceMode());
  }

  const changedPaths = createMemo(() => {
    const entries = gitStatus() ?? [];
    const seen = new Set<string>();
    const list: { path: string; mode: "staged" | "unstaged" }[] = [];
    for (const e of entries) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      const isStaged = e.index_status !== " " && e.index_status !== "?";
      list.push({ path: e.path, mode: isStaged && e.worktree_status === " " ? "staged" : "unstaged" });
    }
    return list;
  });

  const currentFileIndex = createMemo(() => {
    const p = store.review?.path;
    if (!p || store.review?.rev) return -1;
    return changedPaths().findIndex((x) => x.path === p);
  });

  function stepFile(delta: 1 | -1) {
    const list = changedPaths();
    const idx = currentFileIndex();
    if (list.length === 0 || idx < 0) return;
    const next = list[(idx + delta + list.length) % list.length];
    openReview(undefined, basename(next.path), next.path, store.review?.mode ?? next.mode);
  }

  function stepNextUnviewed() {
    const list = changedPaths();
    if (list.length === 0) return;
    const start = Math.max(0, currentFileIndex());
    for (let i = 1; i <= list.length; i++) {
      const candidate = list[(start + i) % list.length];
      if (!isFileViewed(candidate.path)) {
        openReview(undefined, basename(candidate.path), candidate.path, store.review?.mode ?? candidate.mode);
        return;
      }
    }
  }

  const hasUnviewedOther = createMemo(() => {
    const cur = store.review?.path;
    return changedPaths().some((x) => x.path !== cur && !isFileViewed(x.path));
  });

  const activeFileEntry = createMemo(() => {
    const p = store.review?.path;
    if (!p || store.review?.rev) return null;
    return (gitStatus() ?? []).find((e) => e.path === p) ?? null;
  });

  const activeFileIsStaged = createMemo(() => {
    const e = activeFileEntry();
    if (!e) return store.review?.mode === "staged";
    return e.index_status !== " " && e.index_status !== "?";
  });

  const activeFileHasUnstaged = createMemo(() => {
    const e = activeFileEntry();
    if (!e) return store.review?.mode !== "staged";
    return e.worktree_status !== " ";
  });

  async function toggleStageActiveFile() {
    const root = effectiveRoot();
    const p = store.review?.path;
    if (!root || !p || store.review?.rev) return;
    void triggerHaptic("generic");
    try {
      if (activeFileHasUnstaged()) {
        await gitStage(root, [p]);
        openReview(undefined, store.review?.title ?? basename(p), p, "staged");
        toast(`Staged ${basename(p)}`, "success");
      } else {
        await gitUnstage(root, [p]);
        openReview(undefined, store.review?.title ?? basename(p), p, "unstaged");
        toast(`Unstaged ${basename(p)}`, "success");
      }
      bumpGitStatus();
    } catch (err) {
      toast(`Failed to update stage state: ${String(err)}`, "error");
    }
  }

  return (
    <div ref={view} class="changes-view">
      <div class="changes-source-bar">
        <div class="changes-source-tabs" role="tablist" aria-label="Diff source">
          <For each={[{ id: "working", label: "Working" }, { id: "turn", label: "Turn" }, { id: "branch", label: "Branch" }, { id: "commit", label: "Commit" }] as { id: DiffSource; label: string }[]}>
            {(entry) => (
              <button type="button" role="tab" aria-selected={sourceMode() === entry.id} class="changes-source-btn"
                classList={{ "changes-source-on": sourceMode() === entry.id }}
                disabled={entry.id === "turn" && !latestTurn()}
                onClick={() => chooseSource(entry.id)}>
                {entry.label}
                <Show when={entry.id === "turn" && latestTurn()}>{(turn) => <span class="changes-source-count">{turn().files.length}</span>}</Show>
              </button>
            )}
          </For>
        </div>
        <Show when={sourceMode() === "branch"}>
          <input class="ui-field changes-base-ref" list="changes-base-refs" value={baseRef()} placeholder="Base ref (main)" aria-label="Diff base ref"
            onInput={(event) => setBaseRef(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); chooseSource("branch"); } }} />
          <datalist id="changes-base-refs"><For each={branches()}>{(branch) => <option value={branch.remote_ref ?? branch.name} />}</For></datalist>
          <button type="button" class="ui-btn ui-btn-ghost" onClick={() => chooseSource("branch")}>Compare</button>
        </Show>
        <Show when={sourceMode() === "commit"}>
          <select class="ui-field changes-commit-select" value={commitSha()} aria-label="Diff commit"
            onChange={(event) => { setCommitSha(event.currentTarget.value); chooseSource("commit"); }}>
            <For each={commits()}>{(commit) => <option value={commit.sha}>{commit.short_sha} · {commit.message.split("\n")[0].slice(0, 60)}</option>}</For>
          </select>
        </Show>
        <label class="changes-hide-tests">
          <input type="checkbox" checked={hideTests()} onChange={toggleHideTests} /> Hide test files
        </label>
      </div>
      <Show
        when={store.review}
        fallback={
          <>
            <Show when={activeSession()?.worktree}>
              {(wt) => (
                <div class="worktree-banner">
                  <Icon name="gitBranch" size={14} />
                  <span class="worktree-banner-branch" title={wt().path}>
                    Isolated · {wt().branch.replace(/^flipflopper\//, "")} → {wt().source_branch}
                  </span>
                  <button onClick={() => void openWorktreeDialog(activeSession()!.id)}>Merge or discard…</button>
                </div>
              )}
            </Show>
            <SyncHeader sync={gitSync} />
            <div class="changes-tabs">
                <button
                  class="changes-tab"
                  classList={{ "changes-tab-on": store.gitPanelTab === "changes" }}
                  onClick={() => setGitPanelTab("changes")}
                >
                  Changes
                  <Show when={gitChangedCount() > 0}><span class="changes-count">{gitChangedCount()}</span></Show>
                </button>
                <button
                  class="changes-tab"
                  classList={{ "changes-tab-on": store.gitPanelTab === "history" }}
                  onClick={() => setGitPanelTab("history")}
                >
                  <Icon name="history" size={13} /> History
                </button>
            </div>
            <Show when={store.gitPanelTab === "changes"} fallback={<HistoryTab tick={gitTick} />}>
              <ChangesTab status={gitStatus} statusLoading={gitLoading} sync={gitSync} />
            </Show>
          </>
        }
      >
        <div class="changes-diff">
          <div class="changes-diff-nav">
            <button class="changes-back" onClick={closeReview}>
              <Icon name="chevronRight" size={13} style={{ transform: "rotate(180deg)" }} /> Back to changes
            </button>
            <Show when={store.review?.path && !store.review?.rev}>
              <div class="changes-diff-stepper">
                <button
                  type="button"
                  class="git-stage-btn press"
                  classList={{
                    "git-stage-btn-add": activeFileHasUnstaged(),
                    "git-stage-btn-remove": !activeFileHasUnstaged() && activeFileIsStaged(),
                  }}
                  onClick={() => void toggleStageActiveFile()}
                  title={activeFileHasUnstaged() ? "Stage this file" : "Unstage this file"}
                >
                  <Icon name={activeFileHasUnstaged() ? "plus" : "remove"} size={11} />
                  <span>{activeFileHasUnstaged() ? "Stage file" : "Unstage file"}</span>
                </button>
                <Show when={changedPaths().length > 1}>
                  <button
                    type="button"
                    class="changes-nav-chip hover-tint"
                    onClick={() => openReview(undefined, "Working changes")}
                    title="Review all working-tree files together"
                  >
                    <Icon name="list" size={11} /> All ({changedPaths().length})
                  </button>
                  <Show when={hasUnviewedOther()}>
                    <button
                      type="button"
                      class="changes-nav-chip hover-tint"
                      onClick={stepNextUnviewed}
                      title="Jump to next unviewed file"
                    >
                      Next unviewed →
                    </button>
                  </Show>
                  <Show when={currentFileIndex() >= 0}>
                    <button
                      type="button"
                      class="icon-btn press"
                      onClick={() => stepFile(-1)}
                      title="Previous changed file"
                      aria-label="Previous changed file"
                      style={{ width: "22px", height: "22px", "min-width": "22px" }}
                    >
                      <Icon name="chevronRight" size={13} style={{ transform: "rotate(180deg)" }} />
                    </button>
                    <span class="changes-nav-pos">
                      {currentFileIndex() + 1}/{changedPaths().length}
                    </span>
                    <button
                      type="button"
                      class="icon-btn press"
                      onClick={() => stepFile(1)}
                      title="Next changed file"
                      aria-label="Next changed file"
                      style={{ width: "22px", height: "22px", "min-width": "22px" }}
                    >
                      <Icon name="chevronRight" size={13} />
                    </button>
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
          <div class="changes-diff-body"><DiffPane /></div>
        </div>
      </Show>
    </div>
  );
};

export default ChangesView;
