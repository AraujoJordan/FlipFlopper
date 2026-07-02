import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  detectRunTargets,
  onPtyExit,
  ptyKill,
  runProject,
  type RunTarget,
} from "../lib/ipc";
import {
  addTab,
  readRunTargets,
  setStore,
  store,
  writeRunTarget,
} from "../lib/store";
import { Menu, MenuItem, MenuLabel, Spinner, toast } from "./ui";

const PlayIcon: Component<{ color?: string }> = (props) => (
  <svg width="13" height="13" viewBox="0 0 24 24" style={{ color: props.color ?? "currentColor", flex: "0 0 auto" }}>
    <path d="M8 5v14l11-7z" fill="currentColor" />
  </svg>
);

const StopIcon: Component = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" style={{ color: "var(--status-del)", flex: "0 0 auto" }}>
    <path d="M7 7h10v10H7z" fill="currentColor" />
  </svg>
);

const ChevronIcon: Component = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round" style={{ flex: "0 0 auto" }}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const shortLabel = (target: RunTarget) => target.label.split(" - ")[0] || target.id;

const emulatorHint = (target: RunTarget) => {
  if (target.needs_emulator === "android") return "Android device/emulator";
  if (target.needs_emulator === "ios") return "iOS device/simulator";
  return "";
};

const RunButton: Component = () => {
  const [targets, setTargets] = createSignal<RunTarget[]>([]);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [detecting, setDetecting] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  let toggleRef: HTMLDivElement | undefined;
  let runExitUnlisten: (() => void) | null = null;
  let loadSeq = 0;

  const projectPath = () => store.currentProject?.path ?? "";
  const running = () => store.runSessionId !== null;
  const busy = () => detecting() || starting();

  const preferredTarget = () => {
    const list = targets();
    if (list.length === 0) return null;
    const path = projectPath();
    const savedId = path ? readRunTargets()[path] : undefined;
    return list.find((target) => target.id === savedId) ?? list[0];
  };

  async function loadTargets(path: string) {
    const seq = ++loadSeq;
    setDetecting(true);
    try {
      const next = await detectRunTargets(path);
      if (seq === loadSeq) setTargets(next);
    } catch (e) {
      if (seq === loadSeq) {
        setTargets([]);
        toast(`Run detection failed: ${String(e)}`, "error");
      }
    } finally {
      if (seq === loadSeq) setDetecting(false);
    }
  }

  createEffect(() => {
    const path = projectPath();
    runExitUnlisten?.();
    runExitUnlisten = null;
    setStore("runSessionId", null);
    setMenuOpen(false);
    setTargets([]);
    if (path) void loadTargets(path);
  });

  createEffect(() => {
    const path = projectPath();
    if (path && menuOpen()) void loadTargets(path);
  });

  onCleanup(() => {
    runExitUnlisten?.();
    runExitUnlisten = null;
  });

  async function startTarget(target: RunTarget) {
    const path = projectPath();
    if (!path || starting()) return;
    setMenuOpen(false);
    setStarting(true);
    try {
      const sessionId = await runProject(path, target.id);
      writeRunTarget(path, target.id);
      addTab({
        sessionId,
        label: `Run · ${shortLabel(target)}`,
        agentId: "run",
        agentIcon: "",
      });
      setStore("runSessionId", sessionId);
      runExitUnlisten?.();
      runExitUnlisten = await onPtyExit(sessionId, () => {
        if (store.runSessionId === sessionId) setStore("runSessionId", null);
        runExitUnlisten?.();
        runExitUnlisten = null;
      });
    } catch (e) {
      toast(`Run failed: ${String(e)}`, "error");
    } finally {
      setStarting(false);
    }
  }

  async function stopRun() {
    const sessionId = store.runSessionId;
    if (!sessionId) return;
    try {
      await ptyKill(sessionId);
    } catch (e) {
      toast(`Stop failed: ${String(e)}`, "error");
      setStore("runSessionId", null);
      runExitUnlisten?.();
      runExitUnlisten = null;
    }
  }

  async function handleMainClick() {
    if (running()) {
      await stopRun();
      return;
    }
    const target = preferredTarget();
    if (!target) return;
    await startTarget(target);
  }

  const mainTitle = () => {
    if (!projectPath()) return "Open a project to run";
    if (running()) {
      const target = preferredTarget();
      return target ? `Stop ${shortLabel(target)}` : "Stop run";
    }
    if (detecting()) return "Detecting runnable targets";
    return preferredTarget()?.label ?? "No runnable target detected";
  };

  return (
    <div ref={toggleRef} style={{ position: "relative", display: "flex", "align-items": "center" }}>
      <div style={{
        display: "flex",
        "align-items": "center",
        height: "25px",
        background: "var(--surface-3)",
        border: "1px solid var(--border-muted)",
        "border-radius": "var(--radius-md)",
        overflow: "hidden",
      }}>
        <button
          onclick={handleMainClick}
          disabled={!projectPath() || (!running() && targets().length === 0) || busy()}
          title={mainTitle()}
          aria-label={mainTitle()}
          style={{
            height: "23px",
            width: "29px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            color: running()
              ? "var(--status-del)"
              : targets().length > 0
                ? "var(--status-add)"
                : "var(--fg-faint)",
            cursor: !projectPath() || (!running() && targets().length === 0) || busy() ? "default" : "pointer",
          }}
        >
          <Show
            when={!busy()}
            fallback={<Spinner size={12} color="var(--status-add)" />}
          >
            <Show when={running()} fallback={<PlayIcon />}>
              <StopIcon />
            </Show>
          </Show>
        </button>
        <button
          onclick={(e) => {
            e.stopPropagation();
            if (projectPath() && targets().length > 0 && !running()) setMenuOpen((open) => !open);
          }}
          disabled={!projectPath() || targets().length === 0 || running() || starting()}
          title="Run target"
          aria-label="Choose run target"
          style={{
            height: "23px",
            width: "20px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            color: targets().length > 0 && !running() ? "var(--fg-subtle)" : "var(--fg-faint)",
            border: "0",
            "border-left": "1px solid var(--border-muted)",
            cursor: projectPath() && targets().length > 0 && !running() ? "pointer" : "default",
          }}
        >
          <ChevronIcon />
        </button>
      </div>

      <Menu open={menuOpen()} onClose={() => setMenuOpen(false)} anchorRef={toggleRef} align="right" width={360}>
        <MenuLabel>Run project</MenuLabel>
        <For each={targets()}>
          {(target) => {
            const selected = () => preferredTarget()?.id === target.id;
            return (
              <MenuItem
                disabled={starting()}
                onSelect={() => startTarget(target)}
                style={{
                  "align-items": "flex-start",
                  background: selected() ? "var(--surface-4)" : undefined,
                }}
              >
                <PlayIcon color={selected() ? "var(--status-add)" : "var(--fg-muted)"} />
                <div style={{ flex: "1", "min-width": 0 }}>
                  <div style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    "font-size": "12.5px",
                    color: "var(--fg-default)",
                    "font-weight": "500",
                  }}>
                    <span>{shortLabel(target)}</span>
                    <Show when={emulatorHint(target)}>
                      {(hint) => (
                        <span style={{
                          "font-size": "10px",
                          color: "var(--fg-subtle)",
                          border: "1px solid var(--border-muted)",
                          "border-radius": "var(--radius-sm)",
                          padding: "1px 5px",
                        }}>
                          {hint()}
                        </span>
                      )}
                    </Show>
                  </div>
                  <div style={{
                    "font-size": "10.5px",
                    color: "var(--fg-subtle)",
                    "font-family": "var(--font-mono)",
                    "margin-top": "3px",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}>
                    {target.command}
                  </div>
                </div>
                <Show when={selected()}>
                  <span style={{ color: "var(--status-add)", "font-size": "12px" }}>•</span>
                </Show>
              </MenuItem>
            );
          }}
        </For>
        <Show when={detecting()}>
          <div style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            padding: "8px 10px",
            color: "var(--fg-subtle)",
            "font-size": "11px",
          }}>
            <Spinner size={12} />
            Detecting
          </div>
        </Show>
      </Menu>
    </div>
  );
};

export default RunButton;
