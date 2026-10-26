import { Component, Show, createMemo, lazy } from "solid-js";
import { bumpGitStatus, closeReview, effectiveRoot, isFileViewed, openReview, setGitPanelTab, store } from "../../lib/store";
import { gitChangedCount, gitLoading, gitStatus, gitSync, gitTick } from "../../lib/gitStatus";
import { gitStage, gitUnstage, triggerHaptic } from "../../lib/ipc";
import { activeSession } from "../../lib/chat";
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
