import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cache = globalThis.__forkVersionCache ??= new Map();
const TTL = 10 * 60 * 1000;
const official = "https://github.com/decolua/9router.git";

// Git only reads refs/objects here; checks never merge, reset, build or push.
export async function inspectForkVersion(root, git = async (args) => {
  const { stdout } = await execute("git", args, { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10" } });
  return stdout.trim();
}) {
  let deployed;
  try {
    const launcher = JSON.parse(fs.readFileSync(path.join(root, ".fork/launcher.json"), "utf8"));
    deployed = launcher.release?.match(/[/\\]releases[/\\]\d+-([a-f0-9]{12})[/\\]/)?.[1];
  } catch { /* No running managed release. */ }
  if (!deployed) throw new Error("Cannot identify the running fork release");
  const currentSha = await git(["rev-parse", "--verify", `${deployed}^{commit}`]);
  const headSha = await git(["rev-parse", "HEAD"]);
  const version = async (sha) => { try { return JSON.parse(await git(["show", `${sha}:package.json`])).version || null; } catch { return null; } };
  async function compare(label, remote) {
    try {
      const refs = await git(["ls-remote", remote, "refs/heads/master"]);
      const remoteSha = refs.split(/\s+/)[0];
      if (!/^[a-f0-9]{40}$/.test(remoteSha)) throw new Error("Remote branch unavailable");
      try { await git(["cat-file", "-e", `${remoteSha}^{commit}`]); }
      catch { await git(["fetch", "--no-tags", "--no-write-fetch-head", remote, remoteSha]); }
      const [ahead, behind] = (await git(["rev-list", "--left-right", "--count", `${currentSha}...${remoteSha}`])).split(/\s+/).map(Number);
      if (![ahead, behind].every(Number.isInteger)) throw new Error("Invalid comparison");
      return { label, status: behind ? "behind" : "up-to-date", ahead, behind, sha: remoteSha, version: await version(remoteSha) };
    } catch { return { label, status: "unknown", message: "Could not check remote. Check network and Git access, then retry." }; }
  }
  const [origin, upstream, currentVersion] = await Promise.all([compare("Fork origin/master", "origin"), compare("9router upstream/master", official), version(currentSha)]);
  return { available: true, checkedAt: new Date().toISOString(), currentSha, currentVersion, localChangesNotDeployed: headSha !== currentSha, origin, upstream, hasUpdate: origin.behind > 0 || upstream.behind > 0 };
}

export async function forkVersionStatus({ refresh = false } = {}) {
  const root = process.env.NINEROUTER_REPO_ROOT;
  if (!root || !path.isAbsolute(root) || !fs.existsSync(path.join(root, "scripts/sync-upstream.mjs"))) return { available: false };
  const entry = cache.get(root) || {};
  if (entry.pending) return entry.pending;
  if (!refresh && entry.value && Date.now() - entry.at < TTL) return entry.value;
  entry.pending = inspectForkVersion(root).catch(() => ({ available: true, checkedAt: new Date().toISOString(), error: "Could not identify or compare the running fork. Retry after checking Git access." })).then(value => {
    entry.value = value; entry.at = Date.now(); return value;
  }).finally(() => { entry.pending = null; });
  cache.set(root, entry);
  return entry.pending;
}
