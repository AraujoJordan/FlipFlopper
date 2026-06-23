/**
 * TerminalPane — embeds an xterm.js terminal connected to a PTY session.
 *
 * Props:
 *   sessionId — the backend PTY session UUID
 *   active    — whether this terminal is currently visible
 */
import {
  onMount,
  onCleanup,
  createEffect,
  type Component,
} from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onPtyOutput, onPtyExit, ptyInput, ptyResize } from "../lib/ipc";

interface Props {
  sessionId: string;
  active: boolean;
}

const TerminalPane: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement;
  let terminal: Terminal;
  let fitAddon: FitAddon;
  let unlisten: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;

  onMount(async () => {
    terminal = new Terminal({
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
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
        brightWhite: "#f0f6fc",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });

    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef);

    // Fit immediately and emit initial size to the backend
    fitAndResize();

    // Stream PTY output into xterm
    unlisten = await onPtyOutput(props.sessionId, (data) => {
      terminal.write(data);
    });

    // When the PTY exits, mark the tab as dead
    unlistenExit = await onPtyExit(props.sessionId, () => {
      terminal.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    });

    // Send keyboard input to the backend PTY
    terminal.onData((data) => {
      ptyInput(props.sessionId, data).catch(console.error);
    });

    // Re-fit when container is resized
    resizeObserver = new ResizeObserver(() => {
      if (props.active) fitAndResize();
    });
    resizeObserver.observe(containerRef);
  });

  // Re-fit when this tab becomes active
  createEffect(() => {
    if (props.active && fitAddon) {
      // Small delay so the CSS display:none has been lifted
      setTimeout(() => fitAndResize(), 0);
    }
  });

  function fitAndResize() {
    try {
      fitAddon.fit();
      const { cols, rows } = terminal;
      ptyResize(props.sessionId, cols, rows).catch(console.error);
    } catch (_) {
      // Ignore if terminal isn't ready
    }
  }

  onCleanup(() => {
    unlisten?.();
    unlistenExit?.();
    resizeObserver?.disconnect();
    terminal?.dispose();
  });

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        display: props.active ? "block" : "none",
        overflow: "hidden",
      }}
    />
  );
};

export default TerminalPane;
