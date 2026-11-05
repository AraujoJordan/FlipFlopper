# Performance notes and benchmarks

## Startup

Measured on the isolated perf instance (separate identifier, copied app data, production
bundle served by `vite preview`), same Mac. "Window" = process start → first `show()`
resolve; "ready" = process start → `js:ready` (sessions restored, workspace un-hidden).

| | window | ready |
|---|---|---|
| before | 6001 ms | 6210 ms |
| after | **684 ms** | **884 ms** |
| speedup | **~8.6×** | **~6.7×** |

Root cause: `get_tool_catalog` ran `--version` for every developer tool synchronously on
Tauri's main thread (one short-lived process per catalog entry, joined in order). EmptyState
calls `loadInstallable()` on mount — before a session is restored — so every launch blocked
window show and **all** IPC for ~5 s. The appearance code then also asked `setTheme` on a
hidden window, which waited behind the same stall.

Fixes:
- `get_tool_catalog` is `async` (`spawn_blocking`), caches results for 60 s, and each version
  probe has a 1.5 s timeout, so a slow CLI can never hold the catalog.
- EmptyState defers the catalog probe by 1.5 s once the workspace is restored, instead of
  running it on the startup path.
- The window is shown right after the persisted layout is restored (raced against a 250 ms
  cap) so the first visible frame already has the saved theme; `index.html` paints a matching
  dark/light canvas synchronously, and the native window background is primed with the theme
  color before the reveal. Native frame theming (`setTheme`) runs only after the window is
  visible (macOS blocks `setTheme` on hidden windows).

### Initial JS payload

| | main chunk | gzip |
|---|---|---|
| before | 1,065,636 B | 319,587 B |
| after (lazy panes + grammars) | **715,593 B** | **220,796 B** |
| change | **-32.8%** | **-30.9%** |

- `SidePane`, `TerminalDrawer` and the command palette are lazy chunks; the palette mounts only
  when opened.
- Syntax grammars (35 highlight.js languages) load on demand per fence language; core stays
  inline. Each grammar has its own version signal, so a grammar arriving re-renders only the
  Markdown blocks and diff rows that use it — not the whole transcript.
- Install-catalog probing, agent version backfills, CLI-session import scanning and the silent
  update check are deferred out of the first seconds of use.

### Reproduce

```bash
npm run build
npx vite preview --port 1433 --strictPort   # in another terminal
node scripts/startup-bench.mjs --runs 3
```

The benchmark uses `/tmp/ff-perf.conf.json` (perf identifier + `devUrl` to `:1433`) and
`/tmp/ff-perf-data` (copied chat data), so it never touches the real app's data or the dev
port. Startup marks are printed only when the app is launched with `FF_PERF=1` (the
benchmark sets it); the frontend marks run in dev or with `?ffperf=1`.

Bundle metrics: `node scripts/perf.mjs --build --label <name>` writes `perf/<name>.json`
(with build time, payload sizes and a JavaScriptCore parse proxy).

## Notes

- The dev server (`tauri dev`) is not representative of production startup once the frontend
  has parsed; the 5 s stall was backend-side and reproduced identically with a bundled
  frontend.
- Remaining startup budget after the fix: Tauri/plugin/window creation ~300 ms before
  `setup`, webview navigation/parse ~310 ms, bootstrap ~230 ms. Initial JS is still a single
  ~1.07 MB chunk (including 35 syntax-highlighting languages), which is the next target.
