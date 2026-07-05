import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import {
  detectValidationTargets,
  onPtyExit,
  ptyKill,
  validateProject,
  type ValidationTarget,
  triggerHaptic,
} from "../lib/ipc";
import {
  addTerminal,
  readValidationTargets,
  setValidationSessionId,
  store,
  writeValidationTarget,
} from "../lib/store";
import { Menu, MenuItem, MenuLabel, Spinner, toast } from "./ui";

const CheckIcon: Component<{ color?: string }> = (props) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={props.color ?? "currentColor"} stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style={{ flex: "0 0 auto" }}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const StopIcon: Component<{ pulse?: boolean }> = (props) => (
  <svg
    class={props.pulse ? "running-pulse" : undefined}
    width="12" height="12" viewBox="0 0 24 24" style={{ color: "var(--status-del)", flex: "0 0 auto" }}
  >
    <path d="M7 7h10v10H7z" fill="currentColor" />
  </svg>
);

const ChevronIcon: Component<{ open?: boolean }> = (props) => (
  <svg
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"
    style={{
      flex: "0 0 auto",
      transform: props.open ? "rotate(180deg)" : "rotate(0deg)",
      transition: "transform var(--dur-base) var(--ease-standard)",
    }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const shortLabel = (target: ValidationTarget) => target.label.split(" - ")[0] || target.id;

const categoryLabel = (category: string) => {
  switch (category) {
    case "test": return "Tests";
    case "lint": return "Lint";
    case "typecheck": return "Typecheck";
    case "format": return "Format check";
    case "build": return "Build check";
    default: return "Checks";
  }
};

const ValidationButton: Component = () => {
  const [targets, setTargets] = createSignal<ValidationTarget[]>([]);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [detecting, setDetecting] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  let toggleRef: HTMLDivElement | undefined;
  let validationExitUnlisten: (() => void) | null = null;
  let loadSeq = 0;

  const projectPath = () => store.currentProject?.path ?? "";
  const running = () => store.validationSessionId !== null;
  const busy = () => detecting() || starting();

  const preferredTarget = () => {
    const list = targets();
    if (list.length === 0) return null;
    const path = projectPath();
    const savedId = path ? readValidationTargets()[path] : undefined;
    return list.find((target) => target.id === savedId) ?? list[0];
  };

  async function loadTargets(path: string) {
    const seq = ++loadSeq;
    setDetecting(true);
    try {
      const next = await detectValidationTargets(path);
      if (seq === loadSeq) setTargets(next);
    } catch (e) {
      if (seq === loadSeq) {
        setTargets([]);
        toast(`Validation detection failed: ${String(e)}`, "error");
      }
    } finally {
      if (seq === loadSeq) setDetecting(false);
    }
  }

  createEffect(() => {
    const path = projectPath();
    validationExitUnlisten?.();
    validationExitUnlisten = null;
    setValidationSessionId(null);
    setMenuOpen(false);
    setTargets([]);
    if (path) void loadTargets(path);
  });

  createEffect(() => {
    const path = projectPath();
    if (path && menuOpen()) void loadTargets(path);
  });

  onCleanup(() => {
    validationExitUnlisten?.();
    validationExitUnlisten = null;
  });

  async function startTarget(target: ValidationTarget) {
    const path = projectPath();
    if (!path || starting()) return;
    setMenuOpen(false);
    setStarting(true);
    void triggerHaptic("generic");
    try {
      const sessionId = await validateProject(path, target.id);
      writeValidationTarget(path, target.id);
      addTerminal({
        sessionId,
        label: `Validate · ${shortLabel(target)}`,
        kind: "validate",
      });
      setValidationSessionId(sessionId);
      validationExitUnlisten?.();
      validationExitUnlisten = await onPtyExit(sessionId, () => {
        if (store.validationSessionId === sessionId) {
          setValidationSessionId(null);
          void triggerHaptic("alignment");
        }
        validationExitUnlisten?.();
        validationExitUnlisten = null;
      });
    } catch (e) {
      toast(`Validation failed: ${String(e)}`, "error");
    } finally {
      setStarting(false);
    }
  }

  async function stopValidation() {
    const sessionId = store.validationSessionId;
    if (!sessionId) return;
    void triggerHaptic("levelChange");
    try {
      await ptyKill(sessionId);
    } catch (e) {
      toast(`Stop failed: ${String(e)}`, "error");
      setValidationSessionId(null);
      validationExitUnlisten?.();
      validationExitUnlisten = null;
    }
  }

  async function handleMainClick() {
    if (running()) {
      await stopValidation();
      return;
    }
    const target = preferredTarget();
    if (!target) return;
    await startTarget(target);
  }

  const mainTitle = () => {
    if (!projectPath()) return "Open a project to validate";
    if (running()) {
      const target = preferredTarget();
      return target ? `Stop ${shortLabel(target)}` : "Stop validation";
    }
    if (detecting()) return "Detecting validation targets";
    return preferredTarget()?.label ?? "No validation target detected";
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
          class="hover-tint press"
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
                ? "var(--accent)"
                : "var(--fg-faint)",
            cursor: !projectPath() || (!running() && targets().length === 0) || busy() ? "default" : "pointer",
          }}
        >
          <div style={{ position: "relative", width: "13px", height: "13px", display: "flex", "align-items": "center", "justify-content": "center" }}>
            <span class="icon-fade" classList={{ "icon-fade-visible": busy() }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <Spinner size={12} color="var(--accent)" />
            </span>
            <span class="icon-fade" classList={{ "icon-fade-visible": !busy() && !running() }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <CheckIcon />
            </span>
            <span class="icon-fade" classList={{ "icon-fade-visible": !busy() && running() }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <StopIcon pulse />
            </span>
          </div>
        </button>
        <button
          class="hover-tint press"
          onclick={(e) => {
            e.stopPropagation();
            if (projectPath() && targets().length > 0 && !running()) setMenuOpen((open) => !open);
          }}
          disabled={!projectPath() || targets().length === 0 || running() || starting()}
          title="Validation target"
          aria-label="Choose validation target"
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
          <ChevronIcon open={menuOpen()} />
        </button>
      </div>

      <Menu open={menuOpen()} onClose={() => setMenuOpen(false)} anchorRef={toggleRef} align="right" width={360}>
        <MenuLabel>Validate project</MenuLabel>
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
                <CheckIcon color={selected() ? "var(--accent)" : "var(--fg-muted)"} />
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
                    <span style={{
                      "font-size": "10px",
                      color: "var(--fg-subtle)",
                      border: "1px solid var(--border-muted)",
                      "border-radius": "var(--radius-sm)",
                      padding: "1px 5px",
                    }}>
                      {categoryLabel(target.category)}
                    </span>
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
                  <span style={{ color: "var(--accent)", "font-size": "12px" }}>•</span>
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

export default ValidationButton;
