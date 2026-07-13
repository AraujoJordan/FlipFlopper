import { onMount, onCleanup, createEffect, type Component } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onPtyOutput, onPtyExit, ptyInput, ptyResize, ptyAttach, triggerHaptic } from "../lib/ipc";
import { runAction } from "../lib/shortcuts";
import { clearAgentMode, cycleAgentModeOptimistic, sniffAgentMode, setTabNeedsAttention, store } from "../lib/store";
import { cleanTerminalText, isMeaningfulOutput } from "../lib/orchestrator";
import { getIdleTimeoutMinutes } from "../lib/settings";
import { sendNativeNotification } from "../lib/native";
import { getCachedTerminal, registerCachedTerminal, type CachedTerminal } from "../lib/terminalCache";

interface Props {
  sessionId: string;
  active: boolean;
  /** "agent" (default) routes Shift+Tab mode-cycling and printable keys through
   *  the prompt composer's type-through action; "shell" leaves all keys to the
   *  PTY, since a plain terminal has no agent mode and no composer to type into. */
  variant?: "agent" | "shell";
}

/** Build the session-lifetime half of a terminal: the xterm instance, its
 *  detachable container, and the PTY listeners. It outlives any single
 *  TerminalPane mount (project switches remount the whole workspace body) so
 *  a backgrounded project's terminal keeps receiving output and keeps its
 *  scrollback. Torn down via `disposeCachedTerminal` on the store's tab and
 *  project close paths. */
function createCachedTerminal(sessionId: string, isShell: boolean): CachedTerminal {
  const terminal = new Terminal({
    theme: {
      background: "#0b0c10",
      foreground: "#e6edf3",
      cursor: "#58a6ff",
      cursorAccent: "#0b0c10",
      selectionBackground: "rgba(56, 139, 253, 0.3)",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#ffffff",
    },
    fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.0,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";

  terminal.attachCustomKeyEventHandler((ev) => {
    if (isShell) return true;
    if (ev.type !== "keydown") return true;
    if (ev.key === "Tab" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      cycleAgentModeOptimistic(sessionId);
      return true;
    }
    const printable = ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    if (printable) {
      runAction("prompt-type-through", ev.key);
      return false;
    }
    return true;
  });

  // Forward xterm's output to the PTY BEFORE any await / ptyAttach. xterm
  // answers the agent's terminal-capability queries (DA/DSR, cursor-position,
  // etc.) via onData -> ptyInput; if this isn't wired up the instant the
  // backend's buffered first chunk is released, those replies are dropped and
  // query-first TUIs (opencode, agy) hang on a blank frame. Input before
  // attach is harmless: pty_input writes straight to the PTY writer.
  terminal.onData((data) => {
    ptyInput(sessionId, data).catch(console.error);
  });

  let idleTimeoutId: number | null = null;
  function resetIdleTimer() {
    if (isShell) return;
    if (idleTimeoutId !== null) {
      window.clearTimeout(idleTimeoutId);
      idleTimeoutId = null;
    }
    const minutes = getIdleTimeoutMinutes();
    idleTimeoutId = window.setTimeout(() => {
      setTabNeedsAttention(sessionId, true);
      void sendNativeNotification(
        "Agent Idle Alert",
        `The agent has been running but silent for ${minutes} minute${minutes === 1 ? "" : "s"}. It may need attention.`,
      );
    }, minutes * 60 * 1000);
  }

  // Agent rings the bell (\x07) when it needs attention (permission prompt,
  // turn finished); tap the trackpad so it is noticeable while unfocused.
  terminal.onBell(() => {
    void triggerHaptic("level-change");
    setTabNeedsAttention(sessionId, true);
  });

  let disposed = false;
  let unlistenOutput: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;

  void (async () => {
    const un = await onPtyOutput(sessionId, (data) => {
      terminal.write(data);
      sniffAgentMode(sessionId, data);

      // Query-poll noise (cursor-position replies etc.) is not agent activity;
      // letting it reset the timer means the idle alert never fires for TUIs
      // that poll the terminal continuously.
      if (isMeaningfulOutput(cleanTerminalText(data))) resetIdleTimer();

      if (/(?:\? \(y\/n\)|\? \[y\/N\]|Password:)\s*$/i.test(data)) {
        setTabNeedsAttention(sessionId, true);
      }
    });
    if (disposed) return un();
    unlistenOutput = un;

    const unExit = await onPtyExit(sessionId, () => {
      if (idleTimeoutId !== null) {
        window.clearTimeout(idleTimeoutId);
        idleTimeoutId = null;
      }
      clearAgentMode(sessionId);
      terminal.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
      void triggerHaptic("generic");

      const tab = store.tabs.find((x) => x.sessionId === sessionId);
      if (tab) {
        setTabNeedsAttention(sessionId, true);
        void sendNativeNotification("Agent Completed", `Agent "${tab.label}" has finished executing.`);
      }
    });
    if (disposed) return unExit();
    unlistenExit = unExit;

    // Both pty:// and pty-exit:// listeners are now registered — release the
    // backend's buffered first chunk (capability queries, etc.) so xterm.js
    // can answer them and the agent's TUI actually renders. Doing this before
    // the listener exists is what left query-first TUIs (opencode, agy) blank.
    await ptyAttach(sessionId);
  })();

  return {
    terminal,
    fitAddon,
    container,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (idleTimeoutId !== null) window.clearTimeout(idleTimeoutId);
      unlistenOutput?.();
      unlistenExit?.();
      terminal.dispose();
    },
  };
}

const TerminalPane: Component<Props> = (props) => {
  let wrapperRef!: HTMLDivElement;
  let terminal: Terminal;
  let fitAddon: FitAddon;
  let resizeObserver: ResizeObserver | null = null;

  onMount(() => {
    const sessionId = props.sessionId;
    const isShell = props.variant === "shell";
    let entry = getCachedTerminal(sessionId);
    const fresh = !entry;
    if (!entry) {
      entry = createCachedTerminal(sessionId, isShell);
      registerCachedTerminal(sessionId, entry);
    }
    terminal = entry.terminal;
    fitAddon = entry.fitAddon;
    wrapperRef.appendChild(entry.container);

    if (fresh) {
      // open() measures the element, so it must run with the container in the
      // DOM. Only the first mount opens; later mounts re-use the live buffer.
      terminal.open(entry.container);
      fitAndResize();
      if (props.active) {
        if (isShell) terminal.focus();
        else runAction("focus-prompt");
      }
    } else {
      // Re-attached after a project switch: refit to the new wrapper, sync
      // the PTY size, and repaint the preserved buffer.
      setTimeout(() => {
        fitAndResize();
        terminal.refresh(0, terminal.rows - 1);
        if (props.active) {
          if (isShell) terminal.focus();
          else runAction("focus-prompt");
        }
      }, 0);
    }

    resizeObserver = new ResizeObserver(() => {
      if (props.active) fitAndResize();
    });
    resizeObserver.observe(wrapperRef);
  });

  createEffect(() => {
    if (props.active && fitAddon) {
      setTimeout(() => {
        fitAndResize();
        if (props.variant === "shell") terminal.focus();
        else runAction("focus-prompt");
      }, 0);
    }
  });

  function fitAndResize() {
    try {
      fitAddon.fit();
      const { cols, rows } = terminal;
      ptyResize(props.sessionId, cols, rows).catch(console.error);
    } catch { /* terminal not ready yet */ }
  }

  onCleanup(() => {
    // The Terminal, its container, and its PTY listeners live on in
    // terminalCache so a backgrounded project keeps collecting output.
    // disposeCachedTerminal() on the store's close paths tears them down.
    resizeObserver?.disconnect();
  });

  return (
    <div style={{
      position: "absolute", inset: 0,
      display: props.active ? "flex" : "none",
      "flex-direction": "column",
      overflow: "hidden",
      background: "#0b0c10",
      padding: "12px 14px 8px",
    }}>
      <div ref={wrapperRef} style={{ flex: "1", overflow: "hidden" }} />
    </div>
  );
};

export default TerminalPane;
