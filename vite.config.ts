import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [solid()],
  build: {
    // Vite's default target ("baseline-widely-available") makes esbuild's
    // minify pass corrupt @xterm/xterm 6's pre-minified enum pattern
    // (`let r; (...)(r ||= {})` in InputHandler.requestMode loses its `let`,
    // throwing "ReferenceError: Can't find variable: r" the moment an agent
    // sends a DECRQM query like \x1b[?2026$p). That exception kills xterm's
    // write loop, so opencode/agy tabs rendered blank in release builds only.
    // "esnext" skips the syntax-lowering pass that triggers the bug.
    target: "esnext",
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
