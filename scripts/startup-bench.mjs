#!/usr/bin/env node
/** Startup benchmark for the isolated perf instance.
 *  Prereqs: `npm run build` and `npx vite preview --port 1433 --strictPort`.
 *  Runs `tauri dev` with /tmp/ff-perf.conf.json 3 times, parses the [perf] marks,
 *  and reports process→window-shown and process→ready medians.
 *  Usage: node scripts/startup-bench.mjs [--runs 3] */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const runsIndex = process.argv.indexOf("--runs");
const runs = runsIndex >= 0 ? Number(process.argv[runsIndex + 1]) : 3;
const root = process.cwd();
const config = "/tmp/ff-perf.conf.json";
if (!fs.existsSync(config)) throw new Error(`Missing ${config}`);
const dataDir = "/tmp/ff-perf-data";

async function runOnce(index) {
  return await new Promise((resolve, reject) => {
    const child = spawn("npx", ["tauri", "dev", "--config", config], {
      cwd: root,
      env: { ...process.env, FLIPFLOPPER_DATA_DIR: dataDir, FF_PERF: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (output.includes("[perf] js:ready")) {
        clearInterval(timer);
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        const marks = {};
        for (const line of output.split("\n")) {
          const match = line.match(/\[perf\] (\S+) wall=(\d+)(?: js=([\d.]+))?/);
          if (match) marks[match[1]] = { wall: Number(match[2]), js: match[3] ? Number(match[3]) : undefined };
        }
        if (Date.now() - startedAt > 60_000) { reject(new Error("benchmark timed out")); return; }
        const start = marks["rust:run-start"]?.wall;
        const shown = marks["js:shown"]?.wall;
        const ready = marks["js:ready"]?.wall;
        const setup = marks["rust:setup"]?.wall;
        if (!start || !shown || !ready) { reject(new Error(`Missing marks in run ${index}:\n${output}`)); return; }
        resolve({ run: index, setupMs: setup - start, shownMs: shown - start, readyMs: ready - start - (marks["js:shown"] ? 0 : 0) });
      } else if (child.exitCode !== null && !output.includes("[perf]")) {
        clearInterval(timer);
        reject(new Error(`App exited before marks (run ${index}):\n${output.slice(-2000)}`));
      }
    }, 100);
    setTimeout(() => { clearInterval(timer); try { process.kill(-child.pid, "SIGTERM"); } catch {} reject(new Error("benchmark timeout")); }, 90_000);
  });
}

const results = [];
for (let index = 1; index <= runs; index++) {
  try {
    const result = await runOnce(index);
    results.push(result);
    console.log(`run ${index}: setup ${result.setupMs}ms · window ${result.shownMs}ms · ready ${result.readyMs}ms`);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
if (results.length) {
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = {
    at: new Date().toISOString(),
    runs: results,
    medians: {
      setupMs: median(results.map((r) => r.setupMs)),
      shownMs: median(results.map((r) => r.shownMs)),
      readyMs: median(results.map((r) => r.readyMs)),
    },
  };
  fs.mkdirSync(path.join(root, "perf"), { recursive: true });
  fs.writeFileSync(path.join(root, "perf", "startup.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary.medians, null, 2));
}
