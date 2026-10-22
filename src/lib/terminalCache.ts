// Module-level cache of live xterm instances keyed by PTY session id. A
// TerminalPane re-appends the cached container on remount so its scrollback
// and pty:// listeners survive pane changes. Disposal belongs to
// removeTerminal in store.ts, not component unmount.
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
