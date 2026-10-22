// Build-time only. Release bundles never download or install agent helpers.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "src-tauri", "agent-runtime");
const version = "24.22.1";
const platforms = {
  "aarch64-apple-darwin": ["darwin-arm64", "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7"],
  "x86_64-apple-darwin": ["darwin-x64", "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035"],
  "x86_64-unknown-linux-gnu": ["linux-x64", "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c"],
  "x86_64-pc-windows-msvc": ["win-x64", "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5"],
};
const host = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu", "win32-x64": "x86_64-pc-windows-msvc" }[`${process.platform}-${process.arch}`];
const arg = process.argv.indexOf("--target");
const target = (arg >= 0 ? process.argv[arg + 1] : undefined) || process.env.RUNTIME_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || host;
const platform = platforms[target];
if (!platform) throw new Error(`No bundled agent runtime for ${target}`);

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run through npm run prepare:agents so the build uses the selected npm installation.");
const lock = join(runtime, "package-lock.json");
if (!existsSync(lock)) throw new Error("Agent runtime lockfile is missing.");
const fingerprint = createHash("sha256").update(readFileSync(lock)).digest("hex");
const marker = join(runtime, "node_modules", ".flipflopper-lock");
if (!existsSync(marker) || readFileSync(marker, "utf8") !== fingerprint) {
  execFileSync(process.execPath, [npm, "ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtime, stdio: "inherit" });
  writeFileSync(marker, fingerprint);
}

const [name, checksum] = platform;
const windows = name.startsWith("win-");
const binaries = join(root, "src-tauri", "binaries");
const executable = join(binaries, `flipflopper-node-${target}${windows ? ".exe" : ""}`);
const stamp = executable + ".version";
mkdirSync(binaries, { recursive: true });
if (!existsSync(executable) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== version) {
  const archive = windows ? "win-x64/node.exe" : `node-v${version}-${name}.tar.gz`;
  const response = await fetch(`https://nodejs.org/dist/v${version}/${archive}`);
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== checksum) throw new Error("Node checksum mismatch");
  const temporary = join(binaries, `.node-${target}.tmp`);
  if (windows) writeFileSync(temporary, bytes);
  else {
    const archivePath = temporary + ".tar.gz";
    const unpack = temporary + ".unpack";
    mkdirSync(unpack, { recursive: true });
    try {
      writeFileSync(archivePath, bytes);
      execFileSync("tar", ["-xzf", archivePath, "-C", unpack, `node-v${version}-${name}/bin/node`, `node-v${version}-${name}/LICENSE`]);
      copyFileSync(join(unpack, `node-v${version}-${name}/bin/node`), temporary);
      copyFileSync(join(unpack, `node-v${version}-${name}/LICENSE`), join(runtime, "NODE-LICENSE"));
    } finally {
      rmSync(archivePath, { force: true }); rmSync(unpack, { recursive: true, force: true });
    }
  }
  chmodSync(temporary, 0o755);
  renameSync(temporary, executable);
  writeFileSync(stamp, version);
}
if (!existsSync(join(runtime, "NODE-LICENSE"))) {
  const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`);
  if (!license.ok) throw new Error("Cannot download Node license");
  writeFileSync(join(runtime, "NODE-LICENSE"), await license.text());
}
console.log(`Agent runtime ready: Node ${version}, Claude ACP 0.94.0 (${target})`);
