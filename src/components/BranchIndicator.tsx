import { Icon } from "./shell/Icon";
import { Component, createEffect, createSignal, For, Show } from "solid-js";
import {
  store,
  bumpGitStatus,
  updateCurrentBranch,
  activeWorktree,
  effectiveRoot,
} from "../lib/store";
import { runningSessionCount } from "../lib/chat";
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
    if (runningSessionCount() > 0) {
      const ok = await confirmDialog(
        `${runningSessionCount()} agent ${runningSessionCount() === 1 ? "session is" : "sessions are"} running. Switching branches under ${runningSessionCount() === 1 ? "it" : "them"} may lead to unexpected behavior. Switch anyway?`,
        "Switch Branch"
      );
      if (!ok) return;
    }
    setSwitching(true);
    void triggerHaptic("generic");
    try {
      await ensureWorkBranch(effectiveRoot()!, WORK_BRANCH);
      await updateCurrentBranch();
      bumpGitStatus();
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
    if (runningSessionCount() > 0) {
      const ok = await confirmDialog(
        `${runningSessionCount()} agent ${runningSessionCount() === 1 ? "session is" : "sessions are"} running. Switching branches under ${runningSessionCount() === 1 ? "it" : "them"} may lead to unexpected behavior. Switch anyway?`,
        "Switch Branch"
      );
      if (!ok) return;
    }
    setSwitching(true);
    void triggerHaptic("generic");
    try {
      await gitSwitchBranch(effectiveRoot()!, targetBranch);
      await updateCurrentBranch();
      bumpGitStatus();
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
          width: "6px", height: "6px", "border-radius": "50%", "flex-shrink": 0,
          background: dotColor(),
        }} />
        <span style={{ "min-width": 0, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
          <Show when={activeWorktree()} fallback={branch() || "no branch"}>
            {(wt) => <>⎇ {wt().branch.replace(/^flipflopper\//, "")}</>}
          </Show>
        </span>
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
                  <Icon name="gitBranch" size={12} style={{ color: b === branch() ? "var(--accent)" : "var(--fg-subtle)" }} />
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
                    <Icon name="check" size={12} style={{ color: "var(--accent)" }} />
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
