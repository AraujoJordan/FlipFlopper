import { Component, Show, createSignal } from "solid-js";
import type { Resource } from "solid-js";
import { store, bumpGitStatus, toggleGitPanelCollapsed, updateCurrentBranch } from "../../lib/store";
import { gitFetch, gitPull, gitPush, gitCheckoutPrevious, commitsAheadOfRemote, type SyncStatus } from "../../lib/ipc";
import { Button, Spinner, toast } from "../ui";
import { openConflictDialog } from "./ConflictFixDialog";
import { openSquashPushDialog } from "./SquashPushDialog";

type BusyOp = "fetch" | "pull" | "push" | null;

/** Branch / ahead-behind / fetch-pull-push strip pinned to the top of the git panel. */
const SyncHeader: Component<{ sync: Resource<SyncStatus | null> }> = (props) => {
  const [busyOp, setBusyOp] = createSignal<BusyOp>(null);

  const s = () => props.sync();
  const detached = () => s()?.detached ?? false;
  const hasRemote = () => s()?.has_remote ?? false;
  const upstream = () => s()?.upstream ?? null;

  async function run(op: Exclude<BusyOp, null>, fn: () => Promise<string>) {
    if (!store.currentProject || busyOp()) return;
    setBusyOp(op);
    try {
      const msg = await fn();
      bumpGitStatus();
      await updateCurrentBranch();
      toast(msg, "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusyOp(null);
    }
  }

  const doFetch = () => run("fetch", async () => {
    await gitFetch(store.currentProject!.path);
    return "Fetched";
  });

  // Push gets its own handler (not the generic `run`) because it may need to
  // open the squash dialog instead of pushing immediately.
  async function doPush() {
    const project = store.currentProject;
    if (!project || busyOp()) return;
    const branch = s()?.branch ?? "";
    const isPublish = !upstream();
    setBusyOp("push");
    try {
      // Squashing is refused on main/master server-side anyway (mirrors the
      // rollback/rename guards), so skip the dialog there and push directly.
      if (branch !== "main" && branch !== "master") {
        const commits = await commitsAheadOfRemote(project.path);
        if ((isPublish && commits.length >= 1) || commits.length >= 2) {
          openSquashPushDialog({ commits, isPublish });
          return;
        }
      }
      const msg = await gitPush(project.path);
      bumpGitStatus();
      await updateCurrentBranch();
      toast(msg || "Pushed", "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusyOp(null);
    }
  }

  // Pull gets its own handler (not the generic `run`) because a conflicted
  // merge isn't a thrown error — it's a structured outcome that should open
  // the conflict-resolution dialog instead of a plain success/error toast.
  async function doPull() {
    if (!store.currentProject || busyOp()) return;
    setBusyOp("pull");
    try {
      const outcome = await gitPull(store.currentProject.path);
      bumpGitStatus();
      await updateCurrentBranch();
      if (outcome.conflicted) {
        openConflictDialog(outcome.conflicted_paths);
      } else {
        toast(outcome.message || (outcome.merged ? "Merged" : "Pulled"), "success");
      }
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusyOp(null);
    }
  }

  async function backFromDetached() {
    if (!store.currentProject) return;
    try {
      await gitCheckoutPrevious(store.currentProject.path);
      bumpGitStatus();
      await updateCurrentBranch();
      toast("Returned from detached HEAD", "success");
    } catch (e) {
      toast(String(e), "error");
    }
  }

  return (
    <div style={{
      display: "flex", "align-items": "center", gap: "8px",
      padding: "9px 12px",
      "border-bottom": "1px solid var(--border-muted)",
      "min-height": "20px",
    }}>
      <Show
        when={!detached()}
        fallback={
          <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
            <span style={{
              width: "7px", height: "7px", "border-radius": "50%",
              background: "var(--status-mod)", "box-shadow": "0 0 7px var(--status-mod)",
              "flex-shrink": "0",
            }} />
            <span style={{
              "font-family": "var(--font-mono)", "font-size": "11px",
              color: "var(--status-mod)",
            }}>
              detached @ {s()?.head_short_sha || "?"}
            </span>
            <Button size="sm" variant="ghost" onClick={backFromDetached}>Back</Button>
          </div>
        }
      >
        <button
          type="button"
          title="Collapse Source Control"
          onclick={toggleGitPanelCollapsed}
          style={{
            "font-family": "var(--font-mono)", "font-size": "11px",
            color: "var(--fg-default)", "font-weight": "600",
            padding: "0", background: "transparent", border: "0", cursor: "pointer",
          }}
        >
          {s()?.branch || "no branch"}
        </button>
        <Show
          when={upstream()}
          fallback={
            <Show when={s()}>
              <span style={{ "font-size": "10px", color: "var(--fg-faint)" }}>no upstream</span>
            </Show>
          }
        >
          <span style={{ "font-family": "var(--font-mono)", "font-size": "10.5px", display: "flex", gap: "5px" }}>
            <Show when={(s()?.ahead ?? 0) > 0}>
              <span style={{ color: "var(--status-add)" }}>↑{s()?.ahead}</span>
            </Show>
            <Show when={(s()?.behind ?? 0) > 0}>
              <span style={{ color: "var(--status-mod)" }}>↓{s()?.behind}</span>
            </Show>
          </span>
        </Show>
      </Show>

      <div style={{ "margin-left": "auto", display: "flex", "align-items": "center", gap: "2px" }}>
        <Button
          size="sm" variant="ghost"
          disabled={!hasRemote() || busyOp() !== null}
          onClick={doFetch}
          title="Fetch (prune deleted remote branches)"
        >
          <Show when={busyOp() === "fetch"} fallback={
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 11-2.64-6.36M21 4v6h-6" />
            </svg>
          }>
            <Spinner size={11} />
          </Show>
        </Button>
        <Button
          size="sm" variant="ghost"
          disabled={!hasRemote() || !upstream() || busyOp() !== null}
          onClick={doPull}
          title="Pull (fast-forwards when possible, merges otherwise)"
        >
          <Show when={busyOp() === "pull"} fallback={
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          }>
            <Spinner size={11} />
          </Show>
        </Button>
        <Button
          size="sm" variant="ghost"
          disabled={!hasRemote() || busyOp() !== null}
          onClick={doPush}
          title={upstream() ? "Push" : "Publish branch to origin"}
        >
          <Show when={busyOp() === "push"} fallback={
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          }>
            <Spinner size={11} />
          </Show>
        </Button>
      </div>
    </div>
  );
};

export default SyncHeader;
