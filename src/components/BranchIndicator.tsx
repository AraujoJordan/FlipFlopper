import { Icon } from "./shell/Icon";
import {
  Component, createEffect, createMemo, createSignal, For, onCleanup, Show,
} from "solid-js";
import {
  store,
  bumpGitStatus,
  updateCurrentBranch,
  activeWorktree,
  effectiveRoot,
} from "../lib/store";
import { runningSessionCount } from "../lib/chat";
import {
  ensureWorkBranch,
  gitFetch,
  gitListBranches,
  gitSwitchBranch,
  triggerHaptic,
  type BranchInfo,
} from "../lib/ipc";
import { isProtectedBranch, WORK_BRANCH } from "../lib/constants";
import { Menu, MenuItem, MenuDivider, Spinner, confirmDialog, toast } from "./ui";

function normalizeBranchQuery(raw: string): string {
  return raw.trim().replace(/^refs\/(heads|remotes\/origin)\//, "").replace(/^origin\//, "");
}

function isValidNewBranchName(name: string): boolean {
  if (!name || name.length > 120) return false;
  if (/[\s~^:?*[\]\\]/.test(name)) return false;
  if (name.startsWith("-") || name.startsWith(".") || name.endsWith(".") || name.endsWith("/") || name.includes("..")) {
    return false;
  }
  return true;
}

function scoreBranchMatch(branch: BranchInfo, qLower: string): number {
  if (!qLower) return 1;
  const name = branch.name.toLowerCase();
  const remote = (branch.remote_ref ?? "").toLowerCase();
  if (name === qLower) return 100;
  if (name.startsWith(qLower)) return 85;
  const segments = name.split(/[/_-]+/);
  if (segments.some((seg) => seg === qLower)) return 75;
  if (segments.some((seg) => seg.startsWith(qLower))) return 65;
  if (name.includes(qLower)) return 50;
  if (remote.includes(qLower)) return 40;
  // Multi-token match (e.g. "feat auth" matches "feature/user-auth")
  const tokens = qLower.split(/[\s/_-]+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => name.includes(t))) return 30;
  return 0;
}

/** Searchable branch switcher pill used in both the top SessionHeader and the
 *  Changes panel SyncHeader. Filters local + remote branches in real time and
 *  fetches new remote branches in the background while open/typing. */
const BranchIndicator: Component<{ variant?: "header" | "sync" }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  const [fetching, setFetching] = createSignal(false);
  const [newlyFetchedCount, setNewlyFetchedCount] = createSignal(0);
  const [branches, setBranches] = createSignal<BranchInfo[]>([]);
  const [query, setQuery] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(0);

  let toggleRef: HTMLButtonElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let listContainerRef: HTMLDivElement | undefined;
  let lastFetchAt = 0;
  let fetchInFlight = false;

  const branch = () => store.currentBranch;
  const isProtected = () => isProtectedBranch(branch());
  const dotColor = () =>
    !branch() ? "var(--fg-faint)" : isProtected() ? "var(--status-mod)" : "var(--status-add)";

  async function refreshBranchList(root: string): Promise<BranchInfo[]> {
    try {
      const list = await gitListBranches(root, 300);
      setBranches(list);
      return list;
    } catch (e) {
      console.error("Failed to load branches", e);
      return branches();
    }
  }

  async function fetchRemoteBranches(root: string) {
    if (fetchInFlight) return;
    fetchInFlight = true;
    setFetching(true);
    const knownBefore = new Set(branches().map((b) => b.name));
    try {
      await gitFetch(root);
      lastFetchAt = Date.now();
      const updated = await refreshBranchList(root);
      if (knownBefore.size > 0) {
        const added = updated.filter((b) => !knownBefore.has(b.name)).length;
        if (added > 0) {
          setNewlyFetchedCount((n) => n + added);
        }
      }
      bumpGitStatus();
    } catch {
      // Offline or no remote configured — keep local branches without error noise
    } finally {
      fetchInFlight = false;
      setFetching(false);
    }
  }

  // When opened: immediately load local + cached remote branches AND start a
  // live background `git fetch --prune` so newly pushed remote branches stream in.
  createEffect(() => {
    if (!open()) return;
    setQuery("");
    setActiveIndex(0);
    setNewlyFetchedCount(0);
    const root = effectiveRoot();
    if (!root) return;
    void refreshBranchList(root).then(() => {
      void fetchRemoteBranches(root);
    });
    queueMicrotask(() => searchInputRef?.focus());
  });

  const normalizedQuery = createMemo(() => normalizeBranchQuery(query()));

  const filteredBranches = createMemo<BranchInfo[]>(() => {
    const q = normalizedQuery().toLowerCase();
    const all = branches();
    if (!q) return all;
    const scored: { branch: BranchInfo; score: number; idx: number }[] = [];
    all.forEach((b, idx) => {
      const score = scoreBranchMatch(b, q);
      if (score > 0) scored.push({ branch: b, score, idx });
    });
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.branch.is_remote !== b.branch.is_remote) return a.branch.is_remote ? 1 : -1;
      return a.idx - b.idx;
    });
    return scored.map((s) => s.branch);
  });

  const canCreateNew = createMemo(() => {
    const q = normalizedQuery();
    if (!isValidNewBranchName(q)) return false;
    const qLower = q.toLowerCase();
    return !branches().some((b) => b.name.toLowerCase() === qLower);
  });

  const totalOptions = createMemo(
    () => filteredBranches().length + (canCreateNew() ? 1 : 0),
  );

  // Keep activeIndex in bounds and reset to 0 when the user types a new filter.
  createEffect(() => {
    void query();
    setActiveIndex(0);
  });

  createEffect(() => {
    const count = totalOptions();
    if (count > 0 && activeIndex() >= count) {
      setActiveIndex(count - 1);
    }
  });

  // If the user is typing a branch name that isn't found locally yet, trigger a
  // debounced background fetch (throttled to every 6s) so newly pushed branches
  // appear in real time while typing.
  createEffect(() => {
    if (!open()) return;
    const q = normalizedQuery().toLowerCase();
    if (!q) return;
    const hasExact = branches().some((b) => b.name.toLowerCase() === q);
    if (hasExact) return;
    const root = effectiveRoot();
    if (!root) return;
    const timer = window.setTimeout(() => {
      if (Date.now() - lastFetchAt >= 6000 && !fetchInFlight) {
        void fetchRemoteBranches(root);
      }
    }, 420);
    onCleanup(() => window.clearTimeout(timer));
  });

  function scrollActiveIntoView(index: number) {
    queueMicrotask(() => {
      const el = listContainerRef?.querySelector<HTMLElement>(`[data-branch-idx="${index}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  async function confirmIfRunning(): Promise<boolean> {
    if (runningSessionCount() > 0) {
      return confirmDialog(
        `${runningSessionCount()} agent ${runningSessionCount() === 1 ? "session is" : "sessions are"} running. Switching branches under ${runningSessionCount() === 1 ? "it" : "them"} may lead to unexpected behavior. Switch anyway?`,
        "Switch Branch",
      );
    }
    return true;
  }

  async function switchToWorkBranch() {
    const root = effectiveRoot();
    if (!root) return;
    if (!(await confirmIfRunning())) return;
    setSwitching(true);
    void triggerHaptic("generic");
    try {
      await ensureWorkBranch(root, WORK_BRANCH);
      await updateCurrentBranch();
      bumpGitStatus();
      void triggerHaptic("alignment");
      toast(`Switched to ${WORK_BRANCH}`, "success");
      setOpen(false);
    } catch (e) {
      void triggerHaptic("levelChange");
      toast(`Failed to switch branch: ${String(e)}`, "error");
    } finally {
      setSwitching(false);
    }
  }

  async function createAndSwitchBranch(newBranchName: string) {
    const root = effectiveRoot();
    if (!root || !newBranchName) return;
    if (!(await confirmIfRunning())) return;
    setSwitching(true);
    void triggerHaptic("generic");
    try {
      await ensureWorkBranch(root, newBranchName);
      await updateCurrentBranch();
      bumpGitStatus();
      void triggerHaptic("alignment");
      toast(`Created and switched to ${newBranchName}`, "success");
      setOpen(false);
    } catch (e) {
      void triggerHaptic("levelChange");
      toast(`Failed to create branch: ${String(e)}`, "error");
    } finally {
      setSwitching(false);
    }
  }

  async function handleSwitchBranch(targetBranch: string) {
    const root = effectiveRoot();
    if (!root) return;
    if (targetBranch === branch()) {
      setOpen(false);
      return;
    }
    if (!(await confirmIfRunning())) return;
    setSwitching(true);
    void triggerHaptic("generic");
    try {
      await gitSwitchBranch(root, targetBranch);
      await updateCurrentBranch();
      bumpGitStatus();
      void triggerHaptic("alignment");
      toast(`Switched to ${targetBranch}`, "success");
      setOpen(false);
    } catch (e) {
      void triggerHaptic("levelChange");
      toast(`Failed to switch branch: ${String(e)}`, "error");
    } finally {
      setSwitching(false);
    }
  }

  function handleSearchKeyDown(e: KeyboardEvent) {
    const count = totalOptions();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      if (count === 0) return;
      const next = (activeIndex() + 1) % count;
      setActiveIndex(next);
      scrollActiveIntoView(next);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (count === 0) return;
      const next = (activeIndex() - 1 + count) % count;
      setActiveIndex(next);
      scrollActiveIntoView(next);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (switching() || count === 0) return;
      const idx = activeIndex();
      const filtered = filteredBranches();
      if (idx < filtered.length) {
        void handleSwitchBranch(filtered[idx].name);
      } else if (canCreateNew()) {
        void createAndSwitchBranch(normalizedQuery());
      }
      return;
    }
    if (e.key === "Escape" && query().length > 0) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  }

  return (
    <div style={{ position: "relative", "min-width": 0 }}>
      <Show
        when={props.variant === "sync"}
        fallback={
          <button
            ref={toggleRef}
            class="hover-tint"
            onclick={() => store.currentProject && setOpen((o) => !o)}
            title={
              !branch() ? "Click to switch branch" :
              isProtected() ? `On protected branch ${branch()} — click to switch` :
              `On branch ${branch()} — click to switch`
            }
            style={{
              display: "flex", "align-items": "center", gap: "6px",
              "font-family": "var(--font-mono)", "font-size": "11px",
              color: "var(--fg-subtle)",
              cursor: store.currentProject ? "pointer" : "default",
              padding: "2px 6px",
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
        }
      >
        <button
          ref={toggleRef}
          type="button"
          class="branch-sync-trigger hover-tint"
          onclick={() => store.currentProject && setOpen((o) => !o)}
          title="Click to search and switch branch"
        >
          <Icon name="gitBranch" size={12} style={{ color: dotColor(), "flex-shrink": 0 }} />
          <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
            {branch() || "no branch"}
          </span>
          <Icon name="chevronDown" size={11} style={{ color: "var(--fg-faint)", "flex-shrink": 0 }} />
        </button>
      </Show>

      <Menu
        open={open()}
        onClose={() => setOpen(false)}
        anchorRef={toggleRef}
        align={props.variant === "sync" ? "left" : "right"}
        width={300}
      >
        {/* Search input + live remote fetch status */}
        <div class="branch-switcher-search">
          <Icon name="search" size={13} style={{ color: "var(--fg-subtle)", "flex-shrink": 0 }} />
          <input
            ref={searchInputRef}
            type="text"
            class="branch-switcher-input"
            placeholder="Switch or find branch…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
            spellcheck={false}
            autocomplete="off"
          />
          <Show when={query().length > 0}>
            <button
              type="button"
              class="icon-btn press"
              onClick={() => {
                setQuery("");
                searchInputRef?.focus();
              }}
              title="Clear filter"
              style={{ width: "18px", height: "18px", "min-width": "18px" }}
            >
              <Icon name="x" size={11} />
            </button>
          </Show>
          <button
            type="button"
            class="icon-btn press"
            disabled={fetching()}
            onClick={() => {
              const root = effectiveRoot();
              if (root) void fetchRemoteBranches(root);
              searchInputRef?.focus();
            }}
            title={fetching() ? "Fetching remote branches…" : "Fetch remote branches now"}
            style={{ width: "20px", height: "20px", "min-width": "20px" }}
          >
            <Show when={fetching()} fallback={<Icon name="refresh" size={11} />}>
              <Spinner size={11} />
            </Show>
          </button>
        </div>

        {/* Live fetch status bar when pulling remote refs */}
        <Show when={fetching() || newlyFetchedCount() > 0}>
          <div class="branch-switcher-status">
            <Show
              when={fetching()}
              fallback={
                <span style={{ color: "var(--status-add)" }}>
                  +{newlyFetchedCount()} new remote {newlyFetchedCount() === 1 ? "branch" : "branches"} fetched
                </span>
              }
            >
              <span>Fetching latest branches from remote…</span>
            </Show>
          </div>
        </Show>

        <Show when={isProtected() && !query().trim()}>
          <MenuItem disabled={switching()} onSelect={() => void switchToWorkBranch()}>
            <Icon name="gitBranch" size={13} style={{ color: "var(--accent)" }} />
            <span style={{ flex: "1", "font-size": "12px" }}>
              Switch to work branch (<code style={{ "font-family": "var(--font-mono)", "font-size": "11px" }}>{WORK_BRANCH}</code>)
            </span>
            <Show when={switching()}><Spinner size={12} /></Show>
          </MenuItem>
          <MenuDivider />
        </Show>

        <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", padding: "4px 10px 4px" }}>
          <span style={{ "font-size": "10.5px", "letter-spacing": ".5px", "text-transform": "uppercase", color: "var(--fg-subtle)", "font-weight": "600" }}>
            {query().trim() ? `Matching Branches (${filteredBranches().length})` : `Branches (${branches().length})`}
          </span>
          <span style={{ "font-size": "10px", color: "var(--fg-faint)", "font-family": "var(--font-mono)" }}>
            ↑↓ · Enter
          </span>
        </div>

        <div ref={listContainerRef} class="branch-switcher-list">
          <For each={filteredBranches()}>
            {(b, idx) => {
              const isCurrent = () => b.name === branch();
              const isHighlighted = () => idx() === activeIndex();
              return (
                <button
                  type="button"
                  role="menuitem"
                  data-branch-idx={idx()}
                  disabled={switching()}
                  class="branch-switcher-item"
                  classList={{
                    "branch-switcher-item-active": isHighlighted(),
                    "branch-switcher-item-current": isCurrent(),
                  }}
                  onMouseEnter={() => setActiveIndex(idx())}
                  onClick={() => void handleSwitchBranch(b.name)}
                >
                  <Icon
                    name={b.is_remote ? "globe" : "gitBranch"}
                    size={12}
                    style={{
                      color: isCurrent()
                        ? "var(--accent)"
                        : b.is_remote
                          ? "var(--accent-soft)"
                          : "var(--fg-subtle)",
                      "flex-shrink": 0,
                    }}
                  />
                  <div style={{ flex: "1", "min-width": 0, display: "flex", "flex-direction": "column", gap: "1px" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "6px", "min-width": 0 }}>
                      <span
                        style={{
                          "font-family": "var(--font-mono)",
                          "font-size": "11.5px",
                          color: isCurrent() ? "var(--accent)" : "var(--fg-default)",
                          "font-weight": isCurrent() ? "600" : "400",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {b.name}
                      </span>
                      <Show when={b.is_remote}>
                        <span class="branch-remote-badge" title={`Remote branch (${b.remote_ref}) — will create local tracking branch`}>
                          remote
                        </span>
                      </Show>
                    </div>
                    <Show when={b.last_commit_time}>
                      <span style={{ "font-size": "10px", color: "var(--fg-faint)" }}>
                        {b.last_commit_time}
                        <Show when={b.is_remote && b.remote_ref}>
                          {` · ${b.remote_ref}`}
                        </Show>
                      </span>
                    </Show>
                  </div>
                  <Show when={isCurrent()}>
                    <Icon name="check" size={12} style={{ color: "var(--accent)", "flex-shrink": 0 }} />
                  </Show>
                </button>
              );
            }}
          </For>

          <Show when={canCreateNew()}>
            <button
              type="button"
              role="menuitem"
              data-branch-idx={filteredBranches().length}
              disabled={switching()}
              class="branch-switcher-item"
              classList={{
                "branch-switcher-item-active": activeIndex() === filteredBranches().length,
              }}
              onMouseEnter={() => setActiveIndex(filteredBranches().length)}
              onClick={() => void createAndSwitchBranch(normalizedQuery())}
            >
              <Icon name="plus" size={12} style={{ color: "var(--status-add)", "flex-shrink": 0 }} />
              <div style={{ flex: "1", "min-width": 0 }}>
                <div style={{ "font-size": "11.5px", color: "var(--fg-default)" }}>
                  Create & switch to{" "}
                  <code style={{ "font-family": "var(--font-mono)", color: "var(--status-add)" }}>
                    {normalizedQuery()}
                  </code>
                </div>
                <div style={{ "font-size": "10px", color: "var(--fg-faint)" }}>
                  New branch from {branch() || "HEAD"}
                </div>
              </div>
            </button>
          </Show>

          <Show when={filteredBranches().length === 0 && !canCreateNew()}>
            <div style={{ padding: "12px 10px", "font-size": "11.5px", color: "var(--fg-muted)", "text-align": "center" }}>
              {fetching() ? "Searching remote branches…" : "No matching branches"}
            </div>
          </Show>
        </div>
      </Menu>
    </div>
  );
};

export default BranchIndicator;
