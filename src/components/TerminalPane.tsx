import { onMount, onCleanup, createEffect, createSignal, type Component } from "solid-js";
import { Terminal, type ITheme } from "@xterm/xterm";
import { CODE_SCALE_EVENT, MOTION_EVENT, ZOOM_EVENT, layout, resolvedMotion, motionForeground } from "../lib/layout";
import { FitAddon } from "@xterm/addon-fit";
import { findFileReferences } from "../lib/markdownLite";
import { openConversationFile } from "../lib/attachments";
import { toast } from "./ui";
import { ContextMenu, MenuDivider, MenuItem } from "./ui";
import { readClipboardText, writeClipboardText } from "../lib/native";
import { setStore } from "../lib/store";
import { addComposerContext } from "../lib/composerContexts";
import { runAction } from "../lib/shortcuts";
import { openSide } from "../lib/layout";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { onPtyOutput, onPtyExit, ptyInput, ptyResize, ptyAttach } from "../lib/ipc";
import { getCachedTerminal, registerCachedTerminal, type CachedTerminal } from "../lib/terminalCache";

interface Props {
  sessionId: string;
  active: boolean;
  visible?: boolean;
  label?: string;
}

/** Fired by `applyTheme` (lib/layout.ts) after the data-theme attribute changes. */
const THEME_EVENT = "flipflopper:theme-changed";
const terminalFontSize = () => Math.round(13 * layout.codeScale * 10) / 10;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** xterm palette derived from the current app theme tokens. */
function terminalTheme(): ITheme {
  const light = getComputedStyle(document.documentElement).colorScheme === "light";
  const bg = cssVar("--surface-1", "#141A1F");
  return {
    background: bg,
    foreground: cssVar("--fg-body", "#CCD8DD"),
    cursor: cssVar("--accent", "#6366F1"),
    cursorAccent: bg,
    selectionBackground: `rgba(${cssVar("--accent-rgb", "99, 102, 241")}, 0.28)`,
    black: light ? "#142129" : "#91A5B0",
    red: cssVar("--status-del", "#e5675d"),
    green: cssVar("--status-add", "#6fbf73"),
    yellow: cssVar("--status-mod", "#d9a441"),
    blue: cssVar("--status-renamed", "#7aa7e0"),
    magenta: light ? "#6044B8" : "#B2A2FF",
    cyan: light ? "#006C52" : "#8BEBCF",
    white: light ? "#4D626F" : "#CCD8DD",
    brightBlack: light ? "#4D626F" : "#A2B3BC",
    brightRed: light ? "#AD243B" : "#FF929C",
    brightGreen: light ? "#236C3C" : "#8CE0A7",
    brightYellow: light ? "#815900" : "#EAC06B",
    brightBlue: light ? "#315DA8" : "#8DB7FF",
    brightMagenta: light ? "#6044B8" : "#B2A2FF",
    brightCyan: light ? "#006C52" : "#8BEBCF",
    brightWhite: light ? "#142129" : "#F1F6F7",
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
    fontFamily: cssVar(
      "--font-mono",
      '"CaskaydiaCove Nerd Font Mono", "CaskaydiaCove NFM", "CaskaydiaCoveNFM-Regular", ui-monospace, Menlo, monospace',
    ),
    fontSize: terminalFontSize(),
    lineHeight: 1.0,
    fontWeight: "400",
    fontWeightBold: "700",
    cursorBlink: resolvedMotion() === "full" && motionForeground(),
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  // `path/to/file.ts:42` in terminal output opens in the chosen editor at that line.
  terminal.registerLinkProvider({
    provideLinks(row, callback) {
      const text = terminal.buffer.active.getLine(row - 1)?.translateToString(true);
      const links = text ? findFileReferences(text).map((ref) => ({
        range: { start: { x: ref.start + 1, y: row }, end: { x: ref.end, y: row } },
        text: text.slice(ref.start, ref.end),
        activate: () => { void openConversationFile(ref.path, ref.line).catch((error) => toast(`Couldn't open ${ref.path}: ${String(error)}`, "error")); },
      })) : [];
      callback(links.length > 0 ? links : undefined);
    },
  });
  // Localhost URLs open in the preview pane; external URLs use the system browser.
  terminal.registerLinkProvider({
    provideLinks(row, callback) {
      const text = terminal.buffer.active.getLine(row - 1)?.translateToString(true) ?? "";
      const links: { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: () => void }[] = [];
      for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        const url = match[0].replace(/[.,;:!?)\]}'"]+$/g, "");
        if (!url) continue;
        const start = match.index ?? 0;
        links.push({
          range: { start: { x: start + 1, y: row }, end: { x: start + url.length, y: row } },
          text: url,
          activate: () => {
            if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(url)) {
              setStore("previewRequest", { url, ts: Date.now() });
              openSide("preview");
            } else {
              void openUrl(url).catch((error) => toast(`Couldn't open link: ${String(error)}`, "error"));
            }
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });

  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";

  const onThemeChanged = () => { terminal.options.theme = terminalTheme(); };
  window.addEventListener(THEME_EVENT, onThemeChanged);
  const onCodeScaleChanged = () => {
    terminal.options.fontSize = terminalFontSize();
    terminal.options.fontFamily = cssVar("--font-mono", terminal.options.fontFamily ?? "monospace");
    // Only a laid-out terminal can be refit; a hidden one refits when its pane is shown again.
    if (container.getClientRects().length > 0) { try { fitAddon.fit(); } catch { /* not measurable yet */ } }
  };
  window.addEventListener(CODE_SCALE_EVENT, onCodeScaleChanged);
  const onMotionChanged = () => { terminal.options.cursorBlink = !terminal.options.disableStdin && resolvedMotion() === "full" && motionForeground() && container.getClientRects().length > 0; };
  window.addEventListener(MOTION_EVENT, onMotionChanged);
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
      terminal.options.disableStdin = true;
      terminal.options.cursorBlink = false;
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
      window.removeEventListener(MOTION_EVENT, onMotionChanged);
      window.removeEventListener(CODE_SCALE_EVENT, onCodeScaleChanged);
      media.removeEventListener("change", onThemeChanged);
      unlistenOutput?.();
      unlistenExit?.();
      terminal.dispose();
    },
  };
}

const TerminalPane: Component<Props> = (props) => {
  let wrapperRef!: HTMLDivElement;
  let terminal!: Terminal;
  let fitAddon!: FitAddon;
  let resizeObserver: ResizeObserver | null = null;
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);

  function copySelection() {
    const selection = terminal.getSelection();
    if (selection) void writeClipboardText(selection);
    setMenu(null);
  }
  function copyAll() {
    terminal.selectAll();
    const text = terminal.getSelection();
    terminal.clearSelection();
    if (text) void writeClipboardText(text);
    setMenu(null);
  }
  async function pasteClipboard() {
    setMenu(null);
    if (terminal.options.disableStdin) return;
    const text = await readClipboardText();
    if (text) terminal.paste(text);
  }
  function selectAll() {
    terminal.selectAll();
    setMenu(null);
  }
  function jumpToLatest() {
    terminal.scrollToBottom();
    setMenu(null);
  }
  function clearTerminal() {
    terminal.clear();
    setMenu(null);
  }
  function addSelectionToChat() {
    const selection = terminal.getSelection().trim();
    setMenu(null);
    if (!selection) return;
    addComposerContext({
      kind: "terminal",
      label: `Terminal · ${props.label ?? "shell"} · ${selection.split(/\r?\n/)[0]?.slice(0, 48) ?? ""}`,
      detail: `${props.label ?? "Terminal"}\n\n\`\`\`\n${selection}\n\`\`\``,
    });
    runAction("focus-prompt");
    toast(`Added output from ${props.label ?? "the terminal"} to the composer`, "info");
  }

  function terminalKeyDown(event: KeyboardEvent) {
    const mac = navigator.platform.toLowerCase().includes("mac");
    if ((mac ? event.metaKey : event.ctrlKey && event.shiftKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      terminal.selectAll();
    }
  }

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
      if (props.active || props.visible) fitAndResize();
    });
    resizeObserver.observe(wrapperRef);
    const onZoomChanged = () => {
      if (props.active) fitAndResize();
    };
    window.addEventListener(ZOOM_EVENT, onZoomChanged);
    onCleanup(() => window.removeEventListener(ZOOM_EVENT, onZoomChanged));
  });

  createEffect(() => {
    if (props.active && fitAddon) {
      setTimeout(() => {
        fitAndResize();
        terminal.focus();
      }, 0);
    } else if (props.visible && fitAddon) {
      setTimeout(() => fitAndResize(), 0);
    }
  });

  let fitFrame: number | undefined;
  function fitAndResize() {
    if (fitFrame !== undefined) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined;
      if (!wrapperRef?.getClientRects().length) { terminal.options.cursorBlink = false; return; }
      terminal.options.cursorBlink = !terminal.options.disableStdin && props.active && resolvedMotion() === "full" && motionForeground();
      try {
      fitAddon.fit();
      const { cols, rows } = terminal;
      ptyResize(props.sessionId, cols, rows).catch(console.error);
      } catch { /* terminal not ready yet */ }
    });
  }

  onCleanup(() => {
    // The Terminal, its container, and its PTY listeners live on in
    // terminalCache; disposeCachedTerminal() on the close paths tears them down.
    resizeObserver?.disconnect();
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
  });

  return (
    <>
      <div
        style={{
          position: "absolute", inset: 0,
          display: (props.visible ?? props.active) ? "flex" : "none",
          "flex-direction": "column",
          overflow: "hidden",
          background: "var(--surface-1)",
          padding: "10px 12px 6px",
        }}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}
        onKeyDown={terminalKeyDown}
      >
        <div ref={wrapperRef} style={{ flex: "1", overflow: "hidden" }} />
      </div>
      <ContextMenu open={!!menu()} onClose={() => setMenu(null)} x={menu()?.x ?? 0} y={menu()?.y ?? 0} width={210}>
        <MenuItem onSelect={copySelection} disabled={!terminal?.hasSelection()}>Copy</MenuItem>
        <MenuItem onSelect={addSelectionToChat} disabled={!terminal?.hasSelection()}>Add selection to chat</MenuItem>
        <MenuItem onSelect={() => void pasteClipboard()} disabled={terminal?.options.disableStdin}>Paste</MenuItem>
        <MenuDivider />
        <MenuItem onSelect={selectAll}>Select all</MenuItem>
        <MenuItem onSelect={copyAll}>Copy all retained output</MenuItem>
        <MenuDivider />
        <MenuItem onSelect={jumpToLatest}>Jump to latest</MenuItem>
        <MenuItem onSelect={clearTerminal}>Clear terminal</MenuItem>
      </ContextMenu>
    </>
  );
};

export default TerminalPane;
