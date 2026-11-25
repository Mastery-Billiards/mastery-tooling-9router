#!/usr/bin/env node
// Keep the tray process alive while replacing only its HTTP child.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { atomicJson, readJson, waitHealthy, freePort, stopChild } = require("./fork-runtime.cjs");
const root = path.resolve(__dirname, "..");
require("@next/env").loadEnvConfig(root, false);
const dir = path.join(root, ".fork");
const launcherFile = path.join(dir, "launcher.json");
const port = Number(process.env.PORT || 20128);
const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
let child, tray, stopping = false, restarting = false, restartRequested = false;

function releasePath() {
  const link = path.join(dir, "current");
  const candidate = fs.existsSync(link) ? fs.realpathSync(link) : path.join(root, ".next", "standalone");
  if (!fs.existsSync(path.join(candidate, "custom-server.js"))) throw new Error("Build first with npm run build, or prepare a release with npm run fork:prepare");
  return candidate;
}
async function restart() {
  if (restarting) { restartRequested = true; return; }
  restarting = true;
  try {
    const release = releasePath(); // validate before stopping the current process
    await stopChild(child);
    child = spawn(process.execPath, ["--dns-result-order=ipv4first", "--max-old-space-size=6144", path.join(release, "custom-server.js")], {
      cwd: release, stdio: "inherit", env: { ...process.env, PORT: String(port), HOSTNAME: process.env.HOSTNAME_OVERRIDE || "0.0.0.0",
        DATA_DIR: dataDir, NINEROUTER_REPO_ROOT: root, NINEROUTER_FORK_LAUNCHER: String(process.pid) },
    });
    const current = child;
    child.once("error", () => {});
    atomicJson(launcherFile, { pid: process.pid, childPid: child.pid, root, release, port, healthy: false });
    const healthy = await waitHealthy(port, () => current.exitCode === null && !current.signalCode && !stopping);
    atomicJson(launcherFile, { pid: process.pid, childPid: current.pid, root, release, port, healthy });
    if (!healthy) console.error("Fork release failed health check; see update status or restart the previous release.");
  } finally {
    restarting = false;
    if (restartRequested && !stopping) { restartRequested = false; restart().catch((e) => console.error(e.message)); }
  }
}
async function shutdown() {
  if (stopping) return; stopping = true;
  try { require("../cli/src/cli/tray/tray").killTray(); } catch {}
  await stopChild(child);
  if (readJson(launcherFile)?.pid === process.pid) fs.rmSync(launcherFile, { force: true });
  process.exit(0);
}
async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  await freePort(port); // refuse to kill an existing npm instance implicitly
  fs.mkdirSync(dir, { recursive: true });
  const previous = readJson(launcherFile);
  if (previous?.pid) {
    try { process.kill(previous.pid, 0); throw new Error("Fork launcher already running"); }
    catch (e) { if (e.code !== "ESRCH") throw e; }
  }
  // Load the same local .env values used for builds, preserving explicit env vars.
  process.env.DATA_DIR = dataDir;
  process.on("SIGUSR2", () => restart().catch((e) => console.error(e.message)));
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown); process.on("SIGHUP", () => {});
  await restart();
  if (process.env.NINEROUTER_NO_TRAY !== "1") {
    require("../cli/hooks/trayRuntime").ensureTrayRuntime({ silent: true });
    tray = require("../cli/src/cli/tray/tray").initTray({ port, onQuit: shutdown,
      onOpenDashboard: () => {
        const url = `http://localhost:${port}/dashboard`;
        spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" }).on("error", () => {});
      },
      // Existing auto-start helper can point directly at this persistent launcher.
      cliPath: __filename,
    });
    if (!tray) console.warn("Tray could not start; server remains running.");
  }
  console.log(`Fork running on ${port}; source: ${root}`);
  // Recover accidental child crashes without killing the tray.
  setInterval(() => {
    if (!stopping && !restarting && (child.exitCode !== null || child.signalCode)) restart().catch((e) => console.error(e.message));
  }, 5000);
}
main().catch(async (e) => { console.error(e.message); await stopChild(child); process.exit(1); });
