import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir";

const activePhases = ["starting", "checking", "fetching", "merging", "installing", "building", "testing", "restarting", "pushing"];
function repoRoot() {
  const root = process.env.NINEROUTER_REPO_ROOT;
  if (!root || !path.isAbsolute(root) || !fs.existsSync(path.join(root, "scripts", "sync-upstream.mjs"))) return null;
  return root;
}
export function forkSyncStatus() {
  const root = repoRoot();
  if (!root) return { available: false, running: false, phase: "unconfigured", message: "Start the fork using npm run fork:start" };
  let status = { phase: "idle" };
  try { status = JSON.parse(fs.readFileSync(path.join(root, ".fork", "update-status.json"), "utf8")); } catch {}
  let running = false;
  if (activePhases.includes(status.phase) && status.pid) {
    try { process.kill(status.pid, 0); running = true; } catch {}
    if (!running) status = { ...status, phase: "interrupted", message: "Update process stopped; inspect the local sync log before retrying" };
  }
  return { available: true, running, phase: status.phase, message: status.message,
    conflicts: status.conflicts, sha: status.sha, at: status.at };
}
export function startForkSync() {
  const root = repoRoot();
  if (!root) throw new Error("Start the fork using npm run fork:start first");
  if (forkSyncStatus().running) throw new Error("An update is already running");
  const logDir = path.join(DATA_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, "sync-upstream.log"), "a", 0o600);
  try {
    // Fixed program, script and args. No URL/body/branch/command from the request.
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-upstream.mjs")], {
      cwd: root, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, DATA_DIR },
    });
    child.on("error", () => {}); child.unref();
    return { available: true, running: true, phase: "starting" };
  } finally { fs.closeSync(fd); }
}
