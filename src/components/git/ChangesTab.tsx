import { Component, For, Show, createSignal } from "solid-js";
import type { Resource } from "solid-js";
import { store, openReview, bumpGitStatus } from "../../lib/store";
import {
  gitStage, gitUnstage, gitDiscard, gitCommit, gitStashPush, gitStashPop, getGitLog,
  type StatusEntry, type SyncStatus,
} from "../../lib/ipc";
import { Button, Spinner, confirmDialog, toast } from "../ui";
import { isProtectedBranch } from "../../lib/constants";

const iconBtnStyle = {
  display: "flex", "align-items": "center", "justify-content": "center",
  color: "var(--fg-subtle)", padding: "3px", "border-radius": "var(--radius-sm)",
} as const;

function basename(path: string): string {
  return path.split("/").pop() || path;
}

const isStaged = (e: StatusEntry) => e.index_status !== " " && e.index_status !== "?";
const isUnstaged = (e: StatusEntry) => e.worktree_status !== " ";

const FileRow: Component<{ entry: StatusEntry; group: "staged" | "unstaged" }> = (props) => {
  const [hovered, setHovered] = createSignal(false);
  const isUntracked = () => props.entry.index_status === "?" && props.entry.worktree_status === "?";

  const letter = () => {
    const raw = props.group === "staged" ? props.entry.index_status : props.entry.worktree_status;
    if (raw === "?") return "A";
    if (raw === "U") return "!";
    return raw;
  };

  const color = () => {
    switch (letter()) {
      case "A": return "var(--status-add)";
      case "D": return "var(--status-del)";
      case "R":
      case "C": return "var(--status-renamed)";
      case "!": return "var(--status-del)";
      default: return "var(--status-mod)";
    }
  };

  const displayName = () => {
    const name = basename(props.entry.path);
    return props.entry.orig_path ? `${basename(props.entry.orig_path)} → ${name}` : name;
  };

  function openDiff() {
    if (!store.currentProject) return;
    openReview(undefined, basename(props.entry.path), props.entry.path, props.group);
  }

  async function stage(e: MouseEvent) {
    e.stopPropagation();
    if (!store.currentProject) return;
    try {
      await gitStage(store.currentProject.path, [props.entry.path]);
      bumpGitStatus();
    } catch (err) {
      toast(`Stage failed: ${String(err)}`, "error");
    }
  }

  async function unstage(e: MouseEvent) {
    e.stopPropagation();
    if (!store.currentProject) return;
    try {
      await gitUnstage(store.currentProject.path, [props.entry.path]);
      bumpGitStatus();
    } catch (err) {
      toast(`Unstage failed: ${String(err)}`, "error");
    }
  }

  async function discard(e: MouseEvent) {
    e.stopPropagation();
    if (!store.currentProject) return;
    const name = basename(props.entry.path);
    const untracked = isUntracked();
    const ok = await confirmDialog(
      untracked ? `Delete untracked file ${name}?` : `Discard changes to ${name}? This cannot be undone.`,
      untracked ? "Delete" : "Discard",
    );
    if (!ok) return;
    try {
      await gitDiscard(
        store.currentProject.path,
        untracked ? [] : [props.entry.path],
        untracked ? [props.entry.path] : [],
      );
      bumpGitStatus();
    } catch (err) {
      toast(`Discard failed: ${String(err)}`, "error");
    }
  }

  return (
    <div
      onclick={openDiff}
      onmouseenter={() => setHovered(true)}
      onmouseleave={() => setHovered(false)}
      title={props.entry.path}
      style={{
        display: "flex", "align-items": "center", gap: "8px",
        padding: "4px 12px", cursor: "pointer",
      }}
    >
      <span style={{
        color: color(), "font-family": "var(--font-mono)", "font-weight": "700",
        "font-size": "11px", width: "13px", "flex-shrink": "0", "text-align": "center",
      }}>
        {letter()}
      </span>
      <span style={{
        flex: "1", "font-size": "12px", color: "var(--fg-body)",
        overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
      }}>
        {displayName()}
      </span>
      <Show when={hovered()}>
        <span style={{ display: "flex", "align-items": "center", gap: "3px" }}>
          <Show when={props.group === "unstaged"}>
            <button onclick={discard} title="Discard" style={iconBtnStyle}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" />
              </svg>
            </button>
            <button onclick={stage} title="Stage" style={iconBtnStyle}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </Show>
          <Show when={props.group === "staged"}>
            <button onclick={unstage} title="Unstage" style={iconBtnStyle}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14" />
              </svg>
            </button>
          </Show>
        </span>
      </Show>
    </div>
  );
};

const GroupHeader: Component<{ label: string; count: number; actionLabel: string; onAction: () => void }> = (props) => (
  <div style={{ display: "flex", "align-items": "center", gap: "6px", padding: "8px 12px 4px" }}>
    <span style={{
      "font-size": "10.5px", "letter-spacing": ".5px", "text-transform": "uppercase",
      color: "var(--fg-subtle)", "font-weight": "600",
    }}>
      {props.label} ({props.count})
    </span>
    <Show when={props.count > 0}>
      <button
        onclick={props.onAction}
        style={{
          "margin-left": "auto", "font-size": "10.5px", color: "var(--accent-soft)", cursor: "pointer",
        }}
      >
        {props.actionLabel}
      </button>
    </Show>
  </div>
);

const ChangesTab: Component<{
  status: Resource<StatusEntry[]>;
  sync: Resource<SyncStatus | null>;
}> = (props) => {
  const entries = () => props.status() ?? [];
  const staged = () => entries().filter(isStaged);
  const unstaged = () => entries().filter(isUnstaged);

  const [message, setMessage] = createSignal("");
  const [amend, setAmend] = createSignal(false);
  const [committing, setCommitting] = createSignal(false);

  const [stashOpen, setStashOpen] = createSignal(false);
  const [stashMsg, setStashMsg] = createSignal("");
  const [stashBusy, setStashBusy] = createSignal(false);

  async function stageAll() {
    if (!store.currentProject || unstaged().length === 0) return;
    try {
      await gitStage(store.currentProject.path, unstaged().map((e) => e.path));
      bumpGitStatus();
    } catch (e) {
      toast(`Stage all failed: ${String(e)}`, "error");
    }
  }

  async function unstageAll() {
    if (!store.currentProject || staged().length === 0) return;
    try {
      await gitUnstage(store.currentProject.path, staged().map((e) => e.path));
      bumpGitStatus();
    } catch (e) {
      toast(`Unstage all failed: ${String(e)}`, "error");
    }
  }

  async function toggleAmend() {
    const next = !amend();
    setAmend(next);
    if (next && !message().trim() && store.currentProject) {
      try {
        const log = await getGitLog(store.currentProject.path, 1);
        if (log[0]) setMessage(log[0].message);
      } catch {
        // best-effort prefill only
      }
    }
  }

  async function doCommit() {
    if (!store.currentProject) return;
    const msg = message().trim();
    if (!msg) {
      toast("Commit message required", "error");
      return;
    }

    let all = false;
    if (staged().length === 0) {
      if (unstaged().length === 0) {
        toast("Nothing to commit", "error");
        return;
      }
      const ok = await confirmDialog("Nothing staged — commit all changes?", "Commit all");
      if (!ok) return;
      all = true;
    }

    const branch = store.currentBranch;
    if (isProtectedBranch(branch)) {
      const ok = await confirmDialog(`Commit directly to ${branch}?`, "Commit");
      if (!ok) return;
    }

    if (amend() && (props.sync()?.ahead ?? 0) === 0 && props.sync()?.upstream) {
      const ok = await confirmDialog(
        "Amend a commit that's already pushed? This rewrites history.",
        "Amend anyway",
      );
      if (!ok) return;
    }

    setCommitting(true);
    try {
      const result = await gitCommit(store.currentProject.path, msg, all, amend());
      toast(`Committed ${result.sha}`, "success");
      setMessage("");
      setAmend(false);
      bumpGitStatus();
    } catch (e) {
      toast(`Commit failed: ${String(e)}`, "error");
    } finally {
      setCommitting(false);
    }
  }

  async function doStashPush() {
    if (!store.currentProject) return;
    setStashBusy(true);
    try {
      await gitStashPush(store.currentProject.path, stashMsg().trim() || undefined);
      toast("Stashed changes", "success");
      setStashMsg("");
      setStashOpen(false);
      bumpGitStatus();
    } catch (e) {
      toast(`Stash failed: ${String(e)}`, "error");
    } finally {
      setStashBusy(false);
    }
  }

  async function doStashPop() {
    if (!store.currentProject) return;
    setStashBusy(true);
    try {
      await gitStashPop(store.currentProject.path);
      toast("Restored stashed changes", "success");
      bumpGitStatus();
    } catch (e) {
      // A conflicted pop leaves the stash entry intact (nothing is lost) but
      // writes literal conflict markers into the affected files — bump status
      // so those files show up as changed right away, and make the toast
      // sticky since this needs the user's attention, not a 4s auto-dismiss.
      toast(
        `Stash pop conflicted — resolve the conflict markers in the affected files. The stash is kept, nothing was lost. (${String(e)})`,
        "error",
        { sticky: true },
      );
      bumpGitStatus();
    } finally {
      setStashBusy(false);
    }
  }

  return (
    <div style={{ flex: "1", display: "flex", "flex-direction": "column", "min-height": 0 }}>
      <div style={{ flex: "1", overflow: "auto", "padding-bottom": "6px" }}>
        <Show when={props.status.loading && !props.status()}>
          <div style={{ padding: "24px 0", display: "flex", "justify-content": "center" }}>
            <Spinner />
          </div>
        </Show>

        <Show when={!props.status.loading && entries().length === 0}>
          <div style={{ padding: "24px 16px", color: "var(--fg-subtle)", "font-size": "12px", "text-align": "center" }}>
            {store.currentProject ? "No changes" : "Open a project"}
          </div>
        </Show>

        <Show when={staged().length > 0}>
          <GroupHeader label="Staged" count={staged().length} actionLabel="Unstage all" onAction={unstageAll} />
          <For each={staged()}>{(entry) => <FileRow entry={entry} group="staged" />}</For>
        </Show>

        <Show when={unstaged().length > 0}>
          <GroupHeader label="Changes" count={unstaged().length} actionLabel="Stage all" onAction={stageAll} />
          <For each={unstaged()}>{(entry) => <FileRow entry={entry} group="unstaged" />}</For>
        </Show>
      </div>

      {/* Stash row */}
      <div style={{
        flex: "0 0 auto", display: "flex", "align-items": "center", gap: "6px",
        padding: "8px 12px", "border-top": "1px solid var(--border-muted)",
      }}>
        <Show
          when={!stashOpen()}
          fallback={
            <input
              value={stashMsg()}
              oninput={(e) => setStashMsg(e.currentTarget.value)}
              onkeydown={(e) => {
                if (e.key === "Enter") doStashPush();
                if (e.key === "Escape") setStashOpen(false);
              }}
              placeholder="Stash message (optional)"
              autofocus
              style={{
                flex: "1", background: "var(--surface-1)", border: "1px solid var(--accent)",
                "border-radius": "var(--radius-sm)", padding: "4px 7px",
                "font-size": "12px", color: "var(--fg-default)",
              }}
            />
          }
        >
          <Button size="sm" onClick={() => setStashOpen(true)} disabled={entries().length === 0}>
            Stash
          </Button>
          <Button
            size="sm" variant="ghost"
            onClick={doStashPop}
            disabled={(props.sync()?.stash_count ?? 0) === 0 || stashBusy()}
          >
            <Show when={stashBusy()}><Spinner size={11} /></Show>
            Pop
            <Show when={(props.sync()?.stash_count ?? 0) > 0}>
              <span style={{
                "font-family": "var(--font-mono)", "font-size": "9.5px",
                background: "var(--surface-4)", padding: "1px 5px", "border-radius": "999px",
              }}>
                {props.sync()?.stash_count}
              </span>
            </Show>
          </Button>
        </Show>
      </div>

      {/* Commit box */}
      <div style={{
        flex: "0 0 auto", padding: "8px 12px 12px",
        "border-top": "1px solid var(--border-muted)",
        display: "flex", "flex-direction": "column", gap: "6px",
      }}>
        <textarea
          value={message()}
          oninput={(e) => setMessage(e.currentTarget.value)}
          onkeydown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              doCommit();
            }
          }}
          placeholder={staged().length > 0 ? "Commit message…" : "Commit message (will commit all changes)…"}
          rows={3}
          style={{
            resize: "none", background: "var(--surface-1)", border: "1px solid var(--border-default)",
            "border-radius": "var(--radius-md)", padding: "7px 9px",
            "font-family": "var(--font-mono)", "font-size": "12px", color: "var(--fg-default)",
          }}
        />
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <button
            onclick={toggleAmend}
            title="Amend the last commit"
            style={{
              display: "flex", "align-items": "center", gap: "5px",
              "font-size": "11px", color: amend() ? "var(--accent-soft)" : "var(--fg-subtle)",
              cursor: "pointer",
            }}
          >
            <span style={{
              width: "10px", height: "10px", "border-radius": "3px",
              border: `1px solid ${amend() ? "var(--accent-soft)" : "var(--border-strong)"}`,
              background: amend() ? "var(--accent-soft)" : "transparent",
            }} />
            Amend
          </button>
          <Button
            variant="solid" size="sm"
            onClick={doCommit}
            disabled={committing() || !store.currentProject}
            style={{ "margin-left": "auto" }}
          >
            <Show when={committing()}><Spinner size={11} /></Show>
            {amend() ? "Amend" : "Commit"}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ChangesTab;
