import fs from "node:fs";
import path from "node:path";

// Only generated release directories are eligible. Backups and unknown entries
// are never touched; active symlinks and launcher state are additional guards.
export function pruneReleases(forkDir, keep = []) {
  const base = path.resolve(forkDir, "releases");
  const protectedRoots = new Set();
  const protect = (ref) => {
    if (!ref) return;
    const relative = path.relative(base, path.resolve(ref));
    const name = relative.split(path.sep)[0];
    if (/^\d+-[a-f0-9]{12}$/.test(name) && !relative.startsWith("..")) protectedRoots.add(name);
  };
  keep.forEach(protect);
  const current = path.join(forkDir, "current");
  if (fs.existsSync(current)) protect(fs.realpathSync(current));
  const launcherFile = path.join(forkDir, "launcher.json");
  if (fs.existsSync(launcherFile)) protect(JSON.parse(fs.readFileSync(launcherFile, "utf8")).release);
  if (!protectedRoots.size) throw new Error("Refusing release cleanup without a protected release");
  const removed = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+-[a-f0-9]{12}$/.test(entry.name) || protectedRoots.has(entry.name)) continue;
    const dest = path.join(base, entry.name);
    if (fs.realpathSync(dest) !== dest) continue;
    fs.rmSync(dest, { recursive: true }); removed.push(entry.name);
  }
  return { removed, kept: [...protectedRoots] };
}
