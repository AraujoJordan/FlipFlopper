import { onMount, onCleanup, createEffect, type Component } from "solid-js";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onPtyOutput, onPtyExit, ptyInput, ptyResize, ptyAttach } from "../lib/ipc";
import { getCachedTerminal, registerCachedTerminal, type CachedTerminal } from "../lib/terminalCache";

interface Props {
  sessionId: string;
  active: boolean;
}

/** Fired by `applyTheme` (lib/layout.ts) after the data-theme attribute changes. */
const THEME_EVENT = "flipflopper:theme-changed";

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** xterm palette derived from the current app theme tokens. */
function terminalTheme(): ITheme {
  const light = getComputedStyle(document.documentElement).colorScheme === "light";
  const bg = cssVar("--surface-1", "#262624");
  return {
    background: bg,
    foreground: cssVar("--fg-body", "#e8e6dc"),
    cursor: cssVar("--accent", "#d97757"),
    cursorAccent: bg,
    selectionBackground: `rgba(${cssVar("--accent-rgb", "217, 119, 87")}, 0.28)`,
    black: light ? "#3d3d3a" : "#5e5d59",
    red: cssVar("--status-del", "#e5675d"),
    green: cssVar("--status-add", "#6fbf73"),
    yellow: cssVar("--status-mod", "#d9a441"),
    blue: cssVar("--status-renamed", "#7aa7e0"),
    magenta: light ? "#8a4fb8" : "#c39be0",
    cyan: light ? "#1f8a96" : "#5fc4cf",
    white: light ? "#8a8880" : "#b0aea5",
    brightBlack: light ? "#6b6a63" : "#8b8980",
    brightRed: light ? "#d44a3f" : "#f08a82",
    brightGreen: light ? "#3c9d4b" : "#8ad48e",
    brightYellow: light ? "#b9801f" : "#e8bd62",
    brightBlue: light ? "#4a82c9" : "#9bc0f0",
    brightMagenta: light ? "#a064d0" : "#d6b6ec",
    brightCyan: light ? "#2ba1ae" : "#86d9e3",
    brightWhite: light ? "#141413" : "#faf9f5",
  };
}

/** Build the session-lifetime half of a terminal: the xterm instance, its
 *  detachable container, and the PTY listeners. It outlives any single
 *  TerminalPane mount (switching side-pane tabs unmounts nothing, but a
 *  session switch can) so a backgrounded terminal keeps receiving output and
 *  keeps its scrollback. Torn down via `disposeCachedTerminal`. */
function createCachedTerminal(sessionId: string): CachedTerminal {
  const terminal = new Terminal({
    theme: terminalTheme(),
    fontFamily: cssVar("--font-mono", "ui-monospace, Menlo, monospace"),
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

  const onThemeChanged = () => { terminal.options.theme = terminalTheme(); };
  window.addEventListener(THEME_EVENT, onThemeChanged);
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", onThemeChanged);

  // Forward xterm's output to the PTY BEFORE any await / ptyAttach: xterm
  // answers terminal-capability queries via onData -> ptyInput, and replies
  // sent before the listener exists are dropped. Input before attach is
  // harmless: pty_input writes straight to the PTY writer.
  terminal.onData((data) => {
    ptyInput(sessionId, data).catch(console.error);
  });

  let disposed = false;
  let unlistenOutput: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;

  void (async () => {
    const un = await onPtyOutput(sessionId, (data) => terminal.write(data));
    if (disposed) return un();
    unlistenOutput = un;

    const unExit = await onPtyExit(sessionId, () => {
      terminal.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
    });
    if (disposed) return unExit();
    unlistenExit = unExit;

    // Both pty:// and pty-exit:// listeners are registered — release the
    // backend's buffered first chunk so the shell prompt actually renders.
    await ptyAttach(sessionId);
  })();

  return {
    terminal,
    fitAddon,
    container,
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener(THEME_EVENT, onThemeChanged);
      media.removeEventListener("change", onThemeChanged);
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
    let entry = getCachedTerminal(sessionId);
    const fresh = !entry;
    if (!entry) {
      entry = createCachedTerminal(sessionId);
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
      if (props.active) terminal.focus();
    } else {
      // Re-attached: refit to the new wrapper, sync the PTY size, and repaint
      // the preserved buffer.
      setTimeout(() => {
        fitAndResize();
        terminal.refresh(0, terminal.rows - 1);
        if (props.active) terminal.focus();
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
        terminal.focus();
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
    // terminalCache; disposeCachedTerminal() on the close paths tears them down.
    resizeObserver?.disconnect();
  });

  return (
    <div style={{
      position: "absolute", inset: 0,
      display: props.active ? "flex" : "none",
      "flex-direction": "column",
      overflow: "hidden",
      background: "var(--surface-1)",
      padding: "10px 12px 6px",
    }}>
      <div ref={wrapperRef} style={{ flex: "1", overflow: "hidden" }} />
    </div>
  );
};

export default TerminalPane;
