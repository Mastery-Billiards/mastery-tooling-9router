#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import runtime from "./fork-runtime.cjs";
const { atomicJson, readJson, delay, freePort, waitHealthy, stopChild } = runtime;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".fork");
const statusFile = path.join(dir, "update-status.json");
const lock = path.join(dir, "update.lock");
const prepareOnly = process.argv.includes("--prepare");
const logDir = path.join(process.env.DATA_DIR || path.join(os.homedir(), ".9router"), "logs");
fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(logDir, { recursive: true });
const logFd = fs.openSync(path.join(logDir, "sync-upstream.log"), "a", 0o600);
const writeLog = (text) => fs.writeSync(logFd, `[${new Date().toISOString()}] ${text}\n`);
const status = (phase, extra = {}) => { writeLog(phase); atomicJson(statusFile, { phase, pid: process.pid, at: new Date().toISOString(), ...extra }); };
function command(program, args, cwd = root, capture = false, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ["ignore", capture ? "pipe" : logFd, logFd] });
    let out = "";
    if (capture) child.stdout.on("data", (data) => { out += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`${program} failed (${code})`)));
  });
}
async function lockWorker() {
  try { const fd = fs.openSync(lock, "wx", 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (!pid) throw new Error("Update lock requires inspection");
    try { process.kill(pid, 0); throw new Error("An update is already running"); }
    catch (err) { if (err.code !== "ESRCH") throw err; }
    fs.rmSync(lock); await lockWorker();
  }
}
function pointTo(release) {
  const tmp = path.join(dir, `current-${process.pid}`);
  fs.symlinkSync(release, tmp, "dir"); fs.renameSync(tmp, path.join(dir, "current"));
}
async function waitRelease(launcher, release) {
  for (let i = 0; i < 200; i++) {
    const state = readJson(path.join(dir, "launcher.json"));
    if (state?.pid === launcher.pid && state.release === release && state.healthy) return;
    try { process.kill(launcher.pid, 0); } catch { throw new Error("Fork launcher stopped"); }
    await delay(300);
  }
  throw new Error("Release health check failed");
}
let locked = false, probe, probeData;
try {
  await lockWorker(); locked = true;
  status("checking");
  const dirty = await command("git", ["status", "--porcelain", "--untracked-files=all"], root, true);
  if (dirty) { status("dirty", { message: "Commit or move uncommitted files before updating" }); process.exitCode = 1; }
  else {
    const launcher = readJson(path.join(dir, "launcher.json"));
    if (!prepareOnly && (!launcher?.healthy || launcher.root !== root)) throw new Error("Start with npm run fork:start before updating from dashboard");
    if (prepareOnly && launcher?.pid) {
      try { process.kill(launcher.pid, 0); throw new Error("Stop the fork launcher before preparing; use fork:sync while running"); }
      catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    if (!prepareOnly) process.kill(launcher.pid, 0);
    if (!prepareOnly) {
      status("fetching");
      const remotes = (await command("git", ["remote"], root, true)).split("\n");
      if (!remotes.includes("upstream")) await command("git", ["remote", "add", "upstream", "https://github.com/decolua/9router.git"]);
      const remote = await command("git", ["remote", "get-url", "upstream"], root, true);
      if (!["https://github.com/decolua/9router.git", "git@github.com:decolua/9router.git", "https://github.com/decolua/9router"].includes(remote)) throw new Error("Unexpected upstream remote; inspect Git configuration");
      await command("git", ["fetch", "upstream"]);
      status("merging");
      try { await command("git", ["merge", "--no-edit", "upstream/master"]); }
      catch (e) {
        const conflicts = (await command("git", ["diff", "--name-only", "--diff-filter=U"], root, true)).split("\n").filter(Boolean);
        for (const file of conflicts) writeLog(`conflict: ${file}`);
        await command("git", ["merge", "--abort"]).catch(() => {});
        status("conflict", { conflicts, message: "Merge failed; old server is still running" });
        throw Object.assign(e, { reported: true });
      }
    }
    const sha = await command("git", ["rev-parse", "HEAD"], root, true);
    const releaseRoot = path.join(dir, "releases", `${Date.now()}-${sha.slice(0, 12)}`);
    fs.mkdirSync(releaseRoot, { recursive: true });
    const archive = path.join(releaseRoot, "source.tar");
    await command("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"]);
    await command("tar", ["-xf", archive, "-C", releaseRoot]); fs.rmSync(archive);
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
      if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(releaseRoot, name));
    }
    status("installing", { sha }); await command("npm", ["install", "--no-audit", "--no-fund"], releaseRoot);
    status("building", { sha });
    // Next's collection workers initialize the DB while building, too. Keep the
    // whole build on temporary data, not just the candidate health process.
    probeData = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fork-probe-"));
    try { await command("npm", ["run", "build"], releaseRoot, false, { DATA_DIR: probeData, NEXT_DIST_DIR: ".next", NEXT_TRACING_ROOT_MODE: "project" }); }
    catch (e) { status("build-failed", { sha, message: "Build failed; old server is still running" }); throw Object.assign(e, { reported: true }); }
    const release = path.join(releaseRoot, ".next", "standalone");
    // Verify the build without sharing production DB, settings, seats, or tunnels.
    status("testing", { sha });
    const port = await freePort();
    probe = spawn(process.execPath, [path.join(release, "custom-server.js")], { cwd: release, stdio: ["ignore", logFd, logFd],
      env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", DATA_DIR: probeData, NINEROUTER_REPO_ROOT: "", NINEROUTER_FORK_LAUNCHER: "" } });
    probe.on("error", () => {});
    if (!await waitHealthy(port, () => probe.exitCode === null && !probe.signalCode)) throw new Error("Candidate release did not pass isolated health check");
    await stopChild(probe); probe = null;
    if (prepareOnly) { pointTo(release); status("prepared", { sha, release, message: "Ready for npm run fork:start" }); }
    else {
      const previous = launcher.release;
      status("restarting", { sha });
      pointTo(release); process.kill(launcher.pid, "SIGUSR2");
      try { await waitRelease(launcher, release); }
      catch (e) {
        pointTo(previous); process.kill(launcher.pid, "SIGUSR2"); await waitRelease(launcher, previous);
        status("rolled-back", { sha, message: "New release failed; previous release restored" });
        throw Object.assign(e, { reported: true });
      }
      status("pushing", { sha });
      try { await command("git", ["push", "origin", "HEAD"]); }
      catch (e) { status("push-failed", { sha, message: "New release is running; push failed. Retry git push origin HEAD." }); throw Object.assign(e, { reported: true }); }
      status("done", { sha });
    }
  }
} catch (e) {
  if (locked && !e.reported) status("failed", { message: e.message });
  else writeLog(e.message);
  process.exitCode = 1;
} finally {
  await stopChild(probe);
  if (probeData) fs.rmSync(probeData, { recursive: true, force: true });
  if (locked) fs.rmSync(lock, { force: true });
  fs.closeSync(logFd);
}
