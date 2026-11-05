#!/usr/bin/env node
/** Startup-performance baseline: build time, JS/CSS payload, and a JavaScriptCore
 *  parse benchmark of the initial chunk (the engine WebKit/Tauri uses on macOS).
 *  Usage: node scripts/perf.mjs [--build] [--label baseline] */
import { execFileSync, execSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const build = args.includes("--build");
const labelIndex = args.indexOf("--label");
const label = labelIndex >= 0 ? args[labelIndex + 1] : "current";

const root = process.cwd();
const assetsDir = path.join(root, "dist", "assets");
let buildMs = null;
if (build) {
  const started = process.hrtime.bigint();
  execSync("npm run build", { cwd: root, stdio: "ignore" });
  buildMs = Number(process.hrtime.bigint() - started) / 1e6;
}
if (!fs.existsSync(assetsDir)) {
  console.error("dist/assets missing — run with --build first.");
  process.exit(1);
}
const files = fs.readdirSync(assetsDir);
const js = files.filter((name) => name.endsWith(".js"));
const css = files.filter((name) => name.endsWith(".css"));
const size = (name) => fs.statSync(path.join(assetsDir, name)).size;
const gz = (name) => gzipSync(fs.readFileSync(path.join(assetsDir, name))).length;
const main = js.filter((name) => name.startsWith("index-")).sort((a, b) => size(b) - size(a))[0];
if (!main) throw new Error("No index chunk found");

const jsc = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";
const probe = path.join(os.tmpdir(), `ff-perf-${process.pid}.js`);
fs.writeFileSync(probe, `
const source = readFile(${JSON.stringify(path.join(assetsDir, main))});
// Strip the trailing ES-module export list so the chunk can be parsed as a function body.
const stripped = source.replace(/export\\s*\\{[\\s\\S]*\\}\\s*;?\\s*$/, "");
const times = [];
for (let i = 0; i < 9; i++) {
  const start = performance.now();
  try { new Function(stripped); } catch (error) { print(JSON.stringify({ error: String(error).slice(0, 300) })); quit(1); }
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
print(JSON.stringify({ median: times[Math.floor(times.length / 2)], min: times[0] }));
`);
let jscResult;
try {
  jscResult = JSON.parse(execFileSync(jsc, [probe], { encoding: "utf8" }).trim());
} finally {
  fs.rmSync(probe, { force: true });
}
if (jscResult.error) throw new Error(jscResult.error);

const result = {
  label,
  at: new Date().toISOString(),
  buildMs: buildMs === null ? null : Math.round(buildMs),
  distBytes: Number(execSync(`du -sk ${JSON.stringify(path.join(root, "dist"))}`).toString().split(/\s+/)[0]) * 1024,
  jsFiles: js.length,
  jsBytes: js.reduce((total, name) => total + size(name), 0),
  cssBytes: css.reduce((total, name) => total + size(name), 0),
  mainChunk: main,
  mainBytes: size(main),
  mainGzipBytes: gz(main),
  mainParseMs: Number(jscResult.median.toFixed(1)),
  mainParseMinMs: Number(jscResult.min.toFixed(1)),
};
const outDir = path.join(root, "perf");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
