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
import { markTabLimit, type SessionLimitInfo } from "../lib/store";

interface Props {
  sessionId: string;
  active: boolean;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractResetText(text: string): string | null {
  const patterns = [
    /\b(?:access\s+)?resets?\s+(?:in|at|on)\s+([^\n\r.]+)/i,
    /\b(?:reset|available again|try again)\s+(?:in|at|on|after)\s+([^\n\r.]+)/i,
    /\bretry[- ]after[:\s]+([^\n\r.]+)/i,
    /\b(\d+\s*(?:h|hr|hrs|hour|hours)\s*(?:\d+\s*(?:m|min|mins|minute|minutes))?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[0].trim();
  }

  return null;
}

function detectSessionLimit(output: string): SessionLimitInfo | null {
  const text = stripAnsi(output).replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  if (!lower) return null;

  if (
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("max session turns") ||
    lower.includes("max wall time") ||
    lower.includes("maximum output")
  ) {
    return null;
  }

  const hasLimitStop =
    /\b(rate[- ]?limit|usage limit|quota|too many requests|insufficient[_ -]quota|resource_exhausted|credits? exhausted|limit reached|429)\b/i.test(text);
  const hasAccountScope =
    /\b(rate|usage|quota|request|message|credit|plan|daily|weekly|monthly|reset|429)\b/i.test(text);

  if (!hasLimitStop || !hasAccountScope) return null;

  return {
    detectedAt: Date.now(),
    message: text.slice(0, 220),
    resetText: extractResetText(text),
  };
}

const TerminalPane: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement;
  let terminal: Terminal;
  let fitAddon: FitAddon;
  let unlisten: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let recentOutput = "";
  let limitDetected = false;

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
    if (props.active) activateTerminal();

    // Stream PTY output into xterm
    unlisten = await onPtyOutput(props.sessionId, (data) => {
      terminal.write(data);
      recentOutput = `${recentOutput}${data}`.slice(-4000);

      if (!limitDetected && props.active) {
        const limit = detectSessionLimit(recentOutput);
        if (limit) {
          limitDetected = true;
          markTabLimit(props.sessionId, limit);
        }
      }
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
      setTimeout(() => {
        fitAndResize();
        activateTerminal();
      }, 0);
    }
  });

  function activateTerminal() {
    setTimeout(() => terminal?.focus(), 0);
  }

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
