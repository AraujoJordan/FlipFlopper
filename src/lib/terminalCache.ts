// Module-level cache of live xterm instances keyed by PTY session id. A
// project switch remounts the whole workspace (keyed <Show> in App.tsx), but
// the Terminal, its DOM container, and its pty:// listeners live here so a
// backgrounded project's terminal keeps receiving output and its scrollback
// survives the round-trip. TerminalPane re-appends the cached container on
// remount; disposal happens on the tab/project close paths in store.ts.
//
// Imports are type-only so store.ts can import the dispose helpers without
// pulling @xterm/xterm out of the lazily loaded TerminalPane chunk.
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

export interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  /** Element `terminal.open()` was called on; re-appended into the pane wrapper on remount. */
  container: HTMLDivElement;
  /** Releases Tauri listeners and the idle timer, disposes the Terminal. Idempotent. */
  dispose: () => void;
}

const cache = new Map<string, CachedTerminal>();

export function getCachedTerminal(sessionId: string): CachedTerminal | undefined {
  return cache.get(sessionId);
}

export function registerCachedTerminal(sessionId: string, entry: CachedTerminal): void {
  cache.set(sessionId, entry);
}

export function disposeCachedTerminal(sessionId: string): void {
  const entry = cache.get(sessionId);
  if (!entry) return;
  cache.delete(sessionId);
  try {
    entry.dispose();
  } catch (e) {
    console.error("terminalCache: dispose failed for", sessionId, e);
  }
}

export function disposeCachedTerminals(ids: Iterable<string | null | undefined>): void {
  for (const id of ids) {
    if (id) disposeCachedTerminal(id);
  }
}
