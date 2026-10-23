import { Component, Show, lazy } from "solid-js";
import { closeReview, setGitPanelTab, store } from "../../lib/store";
import { gitChangedCount, gitLoading, gitStatus, gitSync, gitTick } from "../../lib/gitStatus";
import { activeSession } from "../../lib/chat";
import { openWorktreeDialog } from "../git/WorktreeCloseDialog";
import { Icon } from "../shell/Icon";
import { useValueMotion, useSelectionMotion } from "../ui";
import SyncHeader from "../git/SyncHeader";
import ChangesTab from "../git/ChangesTab";
import HistoryTab from "../git/HistoryTab";
// Lazy: keeps highlight.js out of the startup bundle until a diff is opened.
const DiffPane = lazy(() => import("../DiffPane"));

/** Source control for the active checkout: sync bar, working-tree changes and
 *  history. Selecting a file or commit drills into its diff (DiffPane) with a
 *  back button. */
const ChangesView: Component = () => {
  let view: HTMLDivElement | undefined;
  useValueMotion(() => view?.querySelector<HTMLElement>(".changes-diff-body, .changes-tabs") ?? undefined, () => `${store.review?.rev ?? ""}:${store.review?.path ?? ""}:${store.gitPanelTab}`);
  useSelectionMotion(() => view, () => store.gitPanelTab, ".changes-tab-on", true);
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
          <button class="changes-back" onClick={closeReview}>
            <Icon name="chevronRight" size={13} style={{ transform: "rotate(180deg)" }} /> Back to changes
          </button>
          <div class="changes-diff-body"><DiffPane /></div>
        </div>
      </Show>
    </div>
  );
};

export default ChangesView;
