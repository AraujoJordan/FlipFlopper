import { onMount, onCleanup, createEffect, type Component } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onPtyOutput, onPtyExit, ptyInput, ptyResize, ptyAttach, triggerHaptic } from "../lib/ipc";
import { runAction } from "../lib/shortcuts";
import { clearAgentMode, cycleAgentModeOptimistic, sniffAgentMode, setTabNeedsAttention, store } from "../lib/store";

interface Props {
  sessionId: string;
  active: boolean;
  /** "agent" (default) routes Shift+Tab mode-cycling and printable keys through
   *  the prompt composer's type-through action; "shell" leaves all keys to the
   *  PTY, since a plain terminal has no agent mode and no composer to type into. */
  variant?: "agent" | "shell";
}

const TerminalPane: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement;
  let terminal: Terminal;
  let fitAddon: FitAddon;
  let unlisten: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let idleTimeoutId: number | null = null;

  onMount(async () => {
    terminal = new Terminal({
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

    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef);
    const isShell = props.variant === "shell";

    terminal.attachCustomKeyEventHandler((ev) => {
      if (isShell) return true;
      if (ev.type !== "keydown") return true;
      if (ev.key === "Tab" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        cycleAgentModeOptimistic(props.sessionId);
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
      ptyInput(props.sessionId, data).catch(console.error);
    });

    fitAndResize();
    if (props.active) {
      if (isShell) terminal.focus();
      else runAction("focus-prompt");
    }

    function resetIdleTimer() {
      if (isShell) return;
      if (idleTimeoutId !== null) {
        window.clearTimeout(idleTimeoutId);
        idleTimeoutId = null;
      }
      idleTimeoutId = window.setTimeout(() => {
        setTabNeedsAttention(props.sessionId, true);
        if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
          try {
            new Notification("Agent Idle Alert", {
              body: `The agent has been running but silent for 5 minutes. It may need attention.`,
            });
          } catch (e) {
            console.error("Failed to send idle notification:", e);
          }
        }
      }, 5 * 60 * 1000);
    }

    unlisten = await onPtyOutput(props.sessionId, (data) => {
      terminal.write(data);
      sniffAgentMode(props.sessionId, data);

      resetIdleTimer();

      if (/(?:\? \(y\/n\)|\? \[y\/N\]|Password:)\s*$/i.test(data)) {
        setTabNeedsAttention(props.sessionId, true);
      }
    });
    // Agent rings the bell (\x07) when it needs attention (permission prompt,
    // turn finished); tap the trackpad so it is noticeable while unfocused.
    terminal.onBell(() => {
      void triggerHaptic("level-change");
      setTabNeedsAttention(props.sessionId, true);
    });

    unlistenExit = await onPtyExit(props.sessionId, () => {
      if (idleTimeoutId !== null) {
        window.clearTimeout(idleTimeoutId);
        idleTimeoutId = null;
      }
      clearAgentMode(props.sessionId);
      terminal.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
      void triggerHaptic("generic");
      
      const tab = store.tabs.find((x) => x.sessionId === props.sessionId);
      if (tab) {
        setTabNeedsAttention(props.sessionId, true);
        if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
          try {
            new Notification("Agent Completed", {
              body: `Agent "${tab.label}" has finished executing.`,
            });
          } catch {}
        }
      }
    });

    // Both pty:// and pty-exit:// listeners are now registered — release the
    // backend's buffered first chunk (capability queries, etc.) so xterm.js
    // can answer them and the agent's TUI actually renders. Doing this before
    // the listener exists is what left query-first TUIs (opencode, agy) blank.
    await ptyAttach(props.sessionId);

    resizeObserver = new ResizeObserver(() => {
      if (props.active) fitAndResize();
    });
    resizeObserver.observe(containerRef);
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
    if (idleTimeoutId !== null) {
      window.clearTimeout(idleTimeoutId);
    }
    unlisten?.();
    unlistenExit?.();
    resizeObserver?.disconnect();
    terminal?.dispose();
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
      <div ref={containerRef} style={{ flex: "1", overflow: "hidden" }} />
    </div>
  );
};

export default TerminalPane;
