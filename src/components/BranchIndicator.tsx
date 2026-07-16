import { Component, createEffect, createSignal, For, Show } from "solid-js";
import {
  store,
  bumpGitStatus,
  bumpFileTree,
  flushAllEditorSaves,
  refreshOpenedFiles,
  updateCurrentBranch,
  activeWorktree,
  effectiveRoot,
} from "../lib/store";
import { ensureWorkBranch, getRecentBranches, gitSwitchBranch, triggerHaptic } from "../lib/ipc";
import { isProtectedBranch, WORK_BRANCH } from "../lib/constants";
import { Menu, MenuLabel, MenuItem, MenuDivider, Spinner, confirmDialog, toast } from "./ui";

/** Title-bar branch pill: shows the current branch, offers a one-click work
 *  branch off a protected branch, and lists recent branches to switch to. */
const BranchIndicator: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  const [recentBranches, setRecentBranches] = createSignal<string[]>([]);
  let toggleRef: HTMLButtonElement | undefined;

  const branch = () => store.currentBranch;
  const isProtected = () => isProtectedBranch(branch());
  const dotColor = () => !branch() ? "var(--fg-faint)" : isProtected() ? "var(--status-mod)" : "var(--status-add)";

  createEffect(() => {
    if (open()) {
      const project = store.currentProject;
      if (project) {
        getRecentBranches(effectiveRoot()!, 15)
          .then(setRecentBranches)
          .catch((e) => {
            console.error("Failed to load recent branches", e);
          });
      }
    }
  });

  async function switchToWorkBranch() {
    const project = store.currentProject;
    if (!project) return;
    if (store.tabs.length > 0) {
      const ok = await confirmDialog(
        `${store.tabs.length} active agent ${store.tabs.length === 1 ? "session is" : "sessions are"} running. Switching branches might interrupt ${store.tabs.length === 1 ? "its" : "their"} context or lead to unexpected behavior. Switch anyway?`,
        "Switch Branch"
      );
      if (!ok) return;
    }
    await flushAllEditorSaves();
    setSwitching(true);
    void triggerHaptic("generic");
    try {
      await ensureWorkBranch(effectiveRoot()!, WORK_BRANCH);
      await updateCurrentBranch();
      bumpGitStatus();
      bumpFileTree();
      await refreshOpenedFiles();
      void triggerHaptic("alignment");
      toast(`Switched to ${WORK_BRANCH}`, "success");
    } catch (e) {
      void triggerHaptic("levelChange");
      toast(`Failed to switch branch: ${String(e)}`, "error");
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }

  async function handleSwitchBranch(targetBranch: string) {
    const project = store.currentProject;
    if (!project) return;
    if (targetBranch === branch()) return;
    if (store.tabs.length > 0) {
      const ok = await confirmDialog(
        `${store.tabs.length} active agent ${store.tabs.length === 1 ? "session is" : "sessions are"} running. Switching branches might interrupt ${store.tabs.length === 1 ? "its" : "their"} context or lead to unexpected behavior. Switch anyway?`,
        "Switch Branch"
      );
      if (!ok) return;
    }
    await flushAllEditorSaves();
    setSwitching(true);
    void triggerHaptic("generic");
    try {
      await gitSwitchBranch(effectiveRoot()!, targetBranch);
      await updateCurrentBranch();
      bumpGitStatus();
      bumpFileTree();
      await refreshOpenedFiles();
      void triggerHaptic("alignment");
      toast(`Switched to ${targetBranch}`, "success");
    } catch (e) {
      void triggerHaptic("levelChange");
      toast(`Failed to switch branch: ${String(e)}`, "error");
    } finally {
      setSwitching(false);
      setOpen(false);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={toggleRef}
        class="hover-tint"
        onclick={() => store.currentProject && setOpen((o) => !o)}
        title={
          !branch() ? "No branch detected" :
          isProtected() ? "Protected branch — auto-commit/rollback disabled" :
          `On branch ${branch()}`
        }
        style={{
          display: "flex", "align-items": "center", gap: "6px",
          "font-family": "var(--font-mono)", "font-size": "11px",
          color: "var(--fg-subtle)",
          cursor: store.currentProject ? "pointer" : "default",
          padding: "2px 4px",
          "border-radius": "var(--radius-sm)",
        }}
      >
        <span style={{
          width: "7px", height: "7px", "border-radius": "50%",
          background: dotColor(), "box-shadow": `0 0 7px ${dotColor()}`,
        }} />
        <Show when={activeWorktree()} fallback={branch() || "no branch"}>
          {(wt) => <>⎇ {wt().branch.replace(/^flipflopper\//, "")}</>}
        </Show>
      </button>

      <Menu open={open()} onClose={() => setOpen(false)} anchorRef={toggleRef} align="right" width={240}>
        <MenuLabel>Current Branch</MenuLabel>
        <div style={{ padding: "4px 10px 8px 10px", "font-family": "var(--font-mono)", "font-size": "12px", color: "var(--fg-default)", display: "flex", "align-items": "center", gap: "6px" }}>
          <span style={{
            width: "6px", height: "6px", "border-radius": "50%",
            background: dotColor(), "box-shadow": `0 0 6px ${dotColor()}`,
          }} />
          {branch() || "no branch"}
        </div>

        <Show when={isProtected()}>
          <MenuItem disabled={switching()} onSelect={switchToWorkBranch}>
            <span style={{ flex: "1", "font-size": "12.5px" }}>Switch to work branch</span>
            <Show when={switching()}><Spinner size={12} /></Show>
          </MenuItem>
        </Show>

        <MenuDivider />

        <MenuLabel>Recent Branches</MenuLabel>
        <div style={{ "max-height": "200px", "overflow-y": "auto", display: "flex", "flex-direction": "column" }}>
          <For each={recentBranches()}>
            {(b) => (
              <MenuItem
                disabled={switching()}
                onSelect={() => handleSwitchBranch(b)}
                style={{
                  padding: "6px 10px",
                  background: b === branch() ? "var(--surface-4)" : "transparent",
                }}
              >
                <div style={{ display: "flex", "align-items": "center", gap: "8px", width: "100%" }}>
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    fill="none"
                    stroke={b === branch() ? "var(--accent)" : "var(--fg-subtle)"}
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <line x1="4" y1="4" x2="4" y2="12" />
                    <circle cx="4" cy="4" r="2" />
                    <circle cx="4" cy="12" r="2" />
                    <path d="M4 8c2.5 0 6 1.5 6 4" />
                    <circle cx="10" cy="12" r="2" />
                  </svg>
                  <span style={{
                    flex: "1",
                    "font-family": "var(--font-mono)",
                    "font-size": "11.5px",
                    color: b === branch() ? "var(--accent)" : "var(--fg-default)",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}>
                    {b}
                  </span>
                  <Show when={b === branch()}>
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style={{ color: "var(--accent)" }}>
                      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                    </svg>
                  </Show>
                </div>
              </MenuItem>
            )}
          </For>
          <Show when={recentBranches().length === 0}>
            <div style={{ padding: "8px 10px", "font-size": "11px", color: "var(--fg-muted)", "font-style": "italic" }}>
              No other branches
            </div>
          </Show>
        </div>
      </Menu>
    </div>
  );
};

export default BranchIndicator;
