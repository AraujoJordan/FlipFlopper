import { onMount, onCleanup, createEffect, type Component } from "solid-js";
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
        background: "#0b0c10",
        foreground: "#c4c8d2",
        cursor: "#d97757",
        cursorAccent: "#0b0c10",
        selectionBackground: "#2a2d3a",
        black: "#3a3d47",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#c4c8d2",
        brightBlack: "#6b6f7c",
        brightRed: "#ff7b72",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#e8eaf0",
      },
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.75,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });

    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef);

    fitAndResize();
    if (props.active) terminal.focus();

    unlisten = await onPtyOutput(props.sessionId, (data) => terminal.write(data));
    unlistenExit = await onPtyExit(props.sessionId, () => {
      terminal.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    });

    terminal.onData((data) => {
      ptyInput(props.sessionId, data).catch(console.error);
    });

    resizeObserver = new ResizeObserver(() => {
      if (props.active) fitAndResize();
    });
    resizeObserver.observe(containerRef);
  });

  createEffect(() => {
    if (props.active && fitAddon) {
      setTimeout(() => { fitAndResize(); terminal?.focus(); }, 0);
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
