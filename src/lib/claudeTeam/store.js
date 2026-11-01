import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { makeKv } from "@/lib/db/helpers/kvStore";
import { getAdapter } from "@/lib/db/driver";

export const teamStore = makeKv("claudeTeam");
const secretDir = () => path.join(DATA_DIR, "claude-team");

// Outside settings/providerConnections: generic settings APIs never return this.
export function saveSession(sessionKey) {
  if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(sessionKey)) throw new Error("Invalid sessionKey format");
  fs.mkdirSync(secretDir(), { recursive: true, mode: 0o700 });
  const keyPath = path.join(secretDir(), "key");
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", fs.readFileSync(keyPath), iv);
  const encrypted = Buffer.concat([cipher.update(sessionKey, "utf8"), cipher.final()]);
  const dest = path.join(secretDir(), "session");
  fs.writeFileSync(dest + ".tmp", Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
  fs.renameSync(dest + ".tmp", dest);
}

export function loadSession() {
  try {
    const data = fs.readFileSync(path.join(secretDir(), "session"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", fs.readFileSync(path.join(secretDir(), "key")), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  } catch { return null; }
}

// Transactional compare-and-set covers HMR and multiple SQLite workers. Unlike
// deleting stale lock files, reclamation cannot race another worker's acquire.
export async function acquireTeamLock() {
  const db = await getAdapter();
  const key = "claudeTeamWorkerLock";
  const owner = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() });
  let acquired = false;
  db.transaction(() => {
    const row = db.get("SELECT value FROM _meta WHERE key = ?", [key]);
    if (row) {
      let previous;
      try { previous = JSON.parse(row.value); } catch { throw new Error("Claude Team lock requires inspection"); }
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error("Invalid Claude Team lock owner");
      try { process.kill(previous.pid, 0); return; }
      catch (e) { if (e.code !== "ESRCH") return; }
    }
    db.run("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, owner]);
    acquired = true;
  });
  if (!acquired) return null;
  return () => db.run("DELETE FROM _meta WHERE key = ? AND value = ?", [key, owner]);
}
