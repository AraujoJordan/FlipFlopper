import { Icon } from "../shell/Icon";
import { Component, For, Show, createSignal } from "solid-js";
import {
  store, openReview, bumpGitStatus, effectiveRoot,
  isFileViewed, setFileViewed, setPendingPromptSeed, setHistoryFilter,
  clearReviewComments, formatReviewBatchPrompt,
} from "../../lib/store";
import { submitPrompt } from "../../lib/chat";
import {
  gitStage, gitUnstage, gitDiscard, gitCommit, gitStashPush, gitStashPop, getGitLog,
  type StatusEntry, type SyncStatus, triggerHaptic,
} from "../../lib/ipc";
import {
  Button, Spinner, Textarea, ContextMenu, MenuItem, MenuDivider, MenuLabel,
  confirmDialog, toast, useListMotion,
} from "../ui";
import { writeClipboardText } from "../../lib/native";
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
  const [removing, setRemoving] = createSignal(false);
  const [menuPos, setMenuPos] = createSignal<{ x: number; y: number } | null>(null);
  const isUntracked = () => props.entry.index_status === "?" && props.entry.worktree_status === "?";
  const viewed = () => isFileViewed(props.entry.path);

  function settle() {
    setRemoving(true);
    bumpGitStatus();
  }

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

  function toggleViewed(next: boolean) {
    setFileViewed(props.entry.path, next);
    void triggerHaptic("generic");
  }

  async function stage(e?: MouseEvent) {
    e?.stopPropagation();
    if (!store.currentProject) return;
    void triggerHaptic("generic");
    try {
      await gitStage(effectiveRoot()!, [props.entry.path]);
      settle();
    } catch (err) {
      toast(`Stage failed: ${String(err)}`, "error");
    }
  }

  async function unstage(e?: MouseEvent) {
    e?.stopPropagation();
    if (!store.currentProject) return;
    void triggerHaptic("generic");
    try {
      await gitUnstage(effectiveRoot()!, [props.entry.path]);
      settle();
    } catch (err) {
      toast(`Unstage failed: ${String(err)}`, "error");
    }
  }

  async function discard(e?: MouseEvent) {
    e?.stopPropagation();
    if (!store.currentProject) return;
    const name = basename(props.entry.path);
    const untracked = isUntracked();
    const ok = await confirmDialog(
      untracked ? `Delete untracked file ${name}?` : `Discard changes to ${name}? This cannot be undone.`,
      { confirmLabel: untracked ? "Delete" : "Discard", danger: true },
    );
    if (!ok) return;
    void triggerHaptic("levelChange");
    try {
      await gitDiscard(
        effectiveRoot()!,
        untracked ? [] : [props.entry.path],
        untracked ? [props.entry.path] : [],
      );
      settle();
    } catch (err) {
      toast(`Discard failed: ${String(err)}`, "error");
    }
  }

  return (
    <>
      <div
        class="git-row" data-motion-key={`${props.group}:${props.entry.path}`}
        classList={{ "git-row-removing": removing(), "git-row-viewed": viewed() }}
        onclick={openDiff}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
        title={props.entry.path}
        style={{
          display: "flex", "align-items": "center", gap: "8px",
          padding: "4px 12px", cursor: "pointer",
        }}
      >
        <label
          class="git-row-viewed-check"
          onclick={(e) => e.stopPropagation()}
          title={viewed() ? "Viewed (click to mark unviewed)" : "Mark file as viewed"}
        >
          <input
            type="checkbox"
            checked={viewed()}
            aria-label={`Mark ${displayName()} as viewed`}
            onChange={(e) => toggleViewed(e.currentTarget.checked)}
          />
        </label>
        <span style={{
          color: color(), "font-family": "var(--font-mono)", "font-weight": "700",
          "font-size": "11px", width: "13px", "flex-shrink": "0", "text-align": "center",
        }}>
          {letter()}
        </span>
        <span style={{
          flex: "1", "font-size": "12px",
          color: viewed() ? "var(--fg-subtle)" : "var(--fg-body)",
          overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
        }}>
          {displayName()}
        </span>
        <span class="git-row-actions" style={{ display: "flex", "align-items": "center", gap: "3px" }}>
          <Show when={props.group === "unstaged"}>
            <button
              type="button"
              class="icon-btn-danger press"
              onclick={discard}
              title={isUntracked() ? "Delete untracked file" : "Discard changes"}
              aria-label={`Discard changes to ${displayName()}`}
              style={iconBtnStyle}
            >
              <Icon name="trash" size={11} />
            </button>
          </Show>
        </span>
        <Show
          when={props.group === "staged"}
          fallback={
            <button
              type="button"
              class="git-stage-btn git-stage-btn-add press"
              onclick={stage}
              title={`Stage ${displayName()}`}
              aria-label={`Stage ${displayName()}`}
            >
              <Icon name="plus" size={11} />
              <span>Stage</span>
            </button>
          }
        >
          <button
            type="button"
            class="git-stage-btn git-stage-btn-remove press"
            onclick={unstage}
            title={`Unstage ${displayName()}`}
            aria-label={`Unstage ${displayName()}`}
          >
            <Icon name="remove" size={11} />
            <span>Unstage</span>
          </button>
        </Show>
      </div>

      <ContextMenu
        open={!!menuPos()}
        onClose={() => setMenuPos(null)}
        x={menuPos()?.x ?? 0}
        y={menuPos()?.y ?? 0}
        width={230}
      >
        <MenuLabel>{displayName()}</MenuLabel>
        <MenuItem onSelect={() => { setMenuPos(null); openDiff(); }}>
          <Icon name="diff" size={15} />
          <span style={{ flex: 1 }}>View diff & select lines</span>
        </MenuItem>
        <MenuItem onSelect={() => { setMenuPos(null); toggleViewed(!viewed()); }}>
          <Icon name={viewed() ? "eye" : "check"} size={15} />
          <span style={{ flex: 1 }}>{viewed() ? "Mark as unviewed" : "Mark as viewed"}</span>
        </MenuItem>
        <MenuItem onSelect={() => {
          setMenuPos(null);
          setPendingPromptSeed({ text: `In \`@${props.entry.path}\`: ` });
        }}>
          <Icon name="message" size={15} />
          <span style={{ flex: 1 }}>Ask changes for file…</span>
        </MenuItem>
        <MenuDivider />
        <Show when={props.group === "unstaged"}>
          <MenuItem onSelect={() => { setMenuPos(null); void stage(); }}>
            <Icon name="plus" size={15} />
            <span style={{ flex: 1 }}>Stage file</span>
          </MenuItem>
          <MenuItem onSelect={() => { setMenuPos(null); void discard(); }}>
            <Icon name="trash" size={15} />
            <span style={{ flex: 1 }}>{isUntracked() ? "Delete untracked file" : "Discard changes"}</span>
          </MenuItem>
        </Show>
        <Show when={props.group === "staged"}>
          <MenuItem onSelect={() => { setMenuPos(null); void unstage(); }}>
            <Icon name="remove" size={15} />
            <span style={{ flex: 1 }}>Unstage file</span>
          </MenuItem>
        </Show>
        <MenuDivider />
        <MenuItem onSelect={() => {
          setMenuPos(null);
          void writeClipboardText(props.entry.path).then(() => toast("Copied path", "success"));
        }}>
          <Icon name="copy" size={15} />
          <span style={{ flex: 1 }}>Copy relative path</span>
        </MenuItem>
        <MenuItem onSelect={() => {
          setMenuPos(null);
          setHistoryFilter(props.entry.path);
        }}>
          <Icon name="history" size={15} />
          <span style={{ flex: 1 }}>File commit history</span>
        </MenuItem>
      </ContextMenu>
    </>
  );
};

const GroupHeader: Component<{
  label: string;
  count: number;
  actionLabel: string;
  actionIcon: "plus" | "remove";
  onAction: () => void;
}> = (props) => (
  <div style={{ display: "flex", "align-items": "center", gap: "6px", padding: "8px 12px 4px" }}>
    <span style={{
      "font-size": "10.5px", "letter-spacing": ".5px", "text-transform": "uppercase",
      color: "var(--fg-subtle)", "font-weight": "600",
    }}>
      {props.label} ({props.count})
    </span>
    <Show when={props.count > 0}>
      <button
        type="button"
        class="git-group-btn press"
        onclick={props.onAction}
        style={{ "margin-left": "auto" }}
      >
        <Icon name={props.actionIcon} size={11} />
        <span>{props.actionLabel}</span>
      </button>
    </Show>
  </div>
);

const ChangesTab: Component<{
  /** `undefined` while data for the current project hasn't landed yet. */
  status: () => StatusEntry[] | undefined;
  statusLoading: () => boolean;
  sync: () => SyncStatus | null | undefined;
}> = (props) => {
  const entries = () => props.status() ?? [];
  const [unviewedOnly, setUnviewedOnly] = createSignal(false);
  const visibleEntries = () =>
    unviewedOnly() ? entries().filter((e) => !isFileViewed(e.path)) : entries();
  let rows: HTMLDivElement | undefined;
  useListMotion(() => rows, () => visibleEntries().map((e) => `${e.path}:${e.index_status}:${e.worktree_status}`).join("|"), ".git-row");
  const staged = () => visibleEntries().filter(isStaged);
  const unstaged = () => visibleEntries().filter(isUnstaged);

  const [message, setMessage] = createSignal("");
  const [amend, setAmend] = createSignal(false);
  const [committing, setCommitting] = createSignal(false);

  const [stashOpen, setStashOpen] = createSignal(false);
  const [stashMsg, setStashMsg] = createSignal("");
  const [stashBusy, setStashBusy] = createSignal(false);
  const [commitFlash, setCommitFlash] = createSignal(false);

  async function stageAll() {
    if (!store.currentProject || unstaged().length === 0) return;
    void triggerHaptic("generic");
    try {
      await gitStage(effectiveRoot()!, unstaged().map((e) => e.path));
      bumpGitStatus();
    } catch (e) {
      toast(`Stage all failed: ${String(e)}`, "error");
    }
  }

  async function unstageAll() {
    if (!store.currentProject || staged().length === 0) return;
    void triggerHaptic("generic");
    try {
      await gitUnstage(effectiveRoot()!, staged().map((e) => e.path));
      bumpGitStatus();
    } catch (e) {
      toast(`Unstage all failed: ${String(e)}`, "error");
    }
  }

  async function toggleAmend() {
    const next = !amend();
    void triggerHaptic("generic");
    setAmend(next);
    if (next && !message().trim() && store.currentProject) {
      try {
        const log = await getGitLog(effectiveRoot()!, 1);
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
        { confirmLabel: "Amend anyway", danger: true },
      );
      if (!ok) return;
    }

    setCommitting(true);
    void triggerHaptic("generic");
    try {
      const result = await gitCommit(effectiveRoot()!, msg, all, amend());
      void triggerHaptic("alignment");
      toast(`Committed ${result.sha}`, "success");
      setMessage("");
      setAmend(false);
      setCommitFlash(true);
      setTimeout(() => setCommitFlash(false), 700);
      bumpGitStatus();
    } catch (e) {
      void triggerHaptic("levelChange");
      toast(`Commit failed: ${String(e)}`, "error");
    } finally {
      setCommitting(false);
    }
  }

  async function doStashPush() {
    if (!store.currentProject) return;
    setStashBusy(true);
    void triggerHaptic("generic");
    try {
      await gitStashPush(effectiveRoot()!, stashMsg().trim() || undefined);
      void triggerHaptic("alignment");
      toast("Stashed changes", "success");
      setStashMsg("");
      setStashOpen(false);
      bumpGitStatus();
    } catch (e) {
      void triggerHaptic("levelChange");
      toast(`Stash failed: ${String(e)}`, "error");
    } finally {
      setStashBusy(false);
    }
  }

  async function doStashPop() {
    if (!store.currentProject) return;
    setStashBusy(true);
    void triggerHaptic("generic");
    try {
      await gitStashPop(effectiveRoot()!);
      void triggerHaptic("alignment");
      toast("Restored stashed changes", "success");
      bumpGitStatus();
    } catch (e) {
      // A conflicted pop leaves the stash entry intact (nothing is lost) but
      // writes literal conflict markers into the affected files — bump status
      // so those files show up as changed right away, and make the toast
      // sticky since this needs the user's attention, not a 4s auto-dismiss.
      void triggerHaptic("levelChange");
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
    <div ref={rows} style={{ flex: "1", display: "flex", "flex-direction": "column", "min-height": 0 }}>
      <div style={{ flex: "1", overflow: "auto", "padding-bottom": "6px" }}>
        <Show when={props.statusLoading() && !props.status()}>
          <div style={{ padding: "24px 0", display: "flex", "justify-content": "center" }}>
            <Spinner />
          </div>
        </Show>

        <Show when={!props.statusLoading() && entries().length === 0}>
          <div style={{ padding: "24px 16px", color: "var(--fg-subtle)", "font-size": "12px", "text-align": "center" }}>
            {store.currentProject ? "No changes" : "Open a project"}
          </div>
        </Show>

        <Show when={store.reviewComments.length > 0}>
          <div class="diff-batch-banner" style={{ margin: "6px 10px 2px", "border-radius": "var(--radius-md)" }}>
            <Icon name="message" size={13} />
            <span class="diff-batch-banner-text">
              <strong>{store.reviewComments.length}</strong> review {store.reviewComments.length === 1 ? "comment" : "comments"} queued
            </span>
            <button
              type="button"
              class="diff-quick-chip press"
              onclick={() => {
                const prompt = formatReviewBatchPrompt(store.reviewComments);
                if (!prompt) return;
                setPendingPromptSeed({ text: prompt });
                clearReviewComments();
                toast("Loaded review into composer", "info");
              }}
            >
              To composer
            </button>
            <Button
              size="sm"
              variant="solid"
              onClick={async () => {
                const prompt = formatReviewBatchPrompt(store.reviewComments);
                if (!prompt) return;
                clearReviewComments();
                toast("Submitted review to agent", "success");
                await submitPrompt(prompt);
              }}
            >
              Submit ({store.reviewComments.length})
            </Button>
          </div>
        </Show>

        <Show when={entries().length > 0}>
          <div style={{
            display: "flex", "align-items": "center", gap: "8px",
            padding: "8px 12px 2px", "font-size": "11px", color: "var(--fg-subtle)",
          }}>
            <span style={{ "font-family": "var(--font-mono)" }}>
              {entries().filter((e) => isFileViewed(e.path)).length} / {entries().length} viewed
            </span>
            <button
              type="button"
              class="diff-quick-chip press"
              classList={{ "diff-quick-chip-on": unviewedOnly() }}
              onclick={() => setUnviewedOnly((v) => !v)}
              title="Toggle showing only unviewed files"
              style={{ padding: "1px 6px", "font-size": "10.5px" }}
            >
              Unviewed only
            </button>
            <button
              type="button"
              class="link-btn press"
              onclick={() => openReview(undefined, "Working changes")}
              style={{
                "margin-left": "auto", display: "inline-flex", "align-items": "center", gap: "4px",
                "font-size": "11px", color: "var(--accent-soft)", cursor: "pointer",
              }}
            >
              <Icon name="diff" size={12} /> Review all
            </button>
          </div>
        </Show>

        <Show when={staged().length > 0}>
          <GroupHeader label="Staged" count={staged().length} actionLabel="Unstage all" actionIcon="remove" onAction={unstageAll} />
          <For each={staged()}>{(entry) => <FileRow entry={entry} group="staged" />}</For>
        </Show>

        <Show when={unstaged().length > 0}>
          <GroupHeader label="Changes" count={unstaged().length} actionLabel="Stage all" actionIcon="plus" onAction={stageAll} />
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
              class="overlay-pop-in"
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
          <Button size="sm" onClick={() => setStashOpen(true)} disabled={entries().length === 0} classList={{ "overlay-pop-in": true }}>
            Stash
          </Button>
          <Button
            size="sm" variant="ghost"
            onClick={doStashPop}
            disabled={(props.sync()?.stash_count ?? 0) === 0 || stashBusy()}
            classList={{ "overlay-pop-in": true }}
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
        <Textarea
          value={message()}
          onInput={setMessage}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              doCommit();
            }
          }}
          placeholder={staged().length > 0 ? "Commit message…" : "Commit message (will commit all changes)…"}
          rows={3}
        />
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <button
            class="press"
            onclick={toggleAmend}
            title="Amend the last commit"
            style={{
              display: "flex", "align-items": "center", gap: "5px",
              "font-size": "11px", color: amend() ? "var(--accent-soft)" : "var(--fg-subtle)",
              cursor: "pointer",
              transition: "color var(--dur-base) var(--ease-standard)",
            }}
          >
            <span style={{
              width: "10px", height: "10px", "border-radius": "3px",
              border: `1px solid ${amend() ? "var(--accent-soft)" : "var(--border-strong)"}`,
              background: amend() ? "var(--accent-soft)" : "transparent",
              transition: "background var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard)",
            }} />
            Amend
          </button>
          <Button
            variant="solid" size="sm"
            onClick={doCommit}
            disabled={committing() || !store.currentProject}
            classList={{ "success-flash": commitFlash() }}
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
