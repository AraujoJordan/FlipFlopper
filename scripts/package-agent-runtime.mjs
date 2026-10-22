// Standalone executable archives need the same resource layout as installers.
import { cpSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
const [binary, output] = process.argv.slice(2);
if (!binary || !output) throw new Error("Usage: package-agent-runtime.mjs <app binary> <archive directory>");
const exeDir = dirname(resolve(binary));
const windows = binary.endsWith(".exe");
const name = `flipflopper-node${windows ? ".exe" : ""}`;
try { cpSync(join(exeDir, name), join(output, name)); }
catch {
  // tauri build can place the signed sidecar only in its installer staging
  // folder. The prepared target binary is the corresponding portable asset.
  const target = binary.includes("aarch64-apple-darwin") ? "aarch64-apple-darwin" : binary.includes("x86_64-apple-darwin") ? "x86_64-apple-darwin" : windows ? "x86_64-pc-windows-msvc" : "x86_64-unknown-linux-gnu";
  cpSync(join("src-tauri", "binaries", `flipflopper-node-${target}${windows ? ".exe" : ""}`), join(output, name));
}
