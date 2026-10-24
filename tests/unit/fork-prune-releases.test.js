import { afterEach, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneReleases } from "../../scripts/prune-releases.mjs";
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fork-prune-"))); dirs.push(root);
  const names = ["1-aaaaaaaaaaaa", "2-bbbbbbbbbbbb", "3-cccccccccccc", "4-dddddddddddd", "unknown"];
  for (const name of names) fs.mkdirSync(path.join(root, "releases", name), { recursive: true });
  const ref = (name) => path.join(root, "releases", name, ".next", "standalone");
  fs.mkdirSync(path.join(root, "backups")); fs.writeFileSync(path.join(root, "backups", "data.sqlite"), "keep");
  return { root, names, ref };
}
it("retains current, rollback and launcher references; removes only generated old builds", () => {
  const t = fixture();
  fs.symlinkSync(path.dirname(path.dirname(t.ref(t.names[3]))), path.join(t.root, "current"));
  fs.writeFileSync(path.join(t.root, "launcher.json"), JSON.stringify({ release: t.ref(t.names[2]) }));
  const result = pruneReleases(t.root, [t.ref(t.names[1])]);
  expect(result.removed).toEqual([t.names[0]]);
  expect(fs.existsSync(path.join(t.root, "backups", "data.sqlite"))).toBe(true);
  expect(fs.existsSync(path.join(t.root, "releases", "unknown"))).toBe(true);
});
it("fails closed when no release is protected or launcher metadata is invalid", () => {
  const t = fixture(); expect(() => pruneReleases(t.root)).toThrow("protected release");
  fs.writeFileSync(path.join(t.root, "launcher.json"), "invalid");
  expect(() => pruneReleases(t.root, [t.ref(t.names[1])])).toThrow();
  expect(fs.existsSync(path.join(t.root, "releases", t.names[0]))).toBe(true);
});
it("never follows directory symlinks while deleting", () => {
  const t = fixture(); const other = fixture();
  fs.symlinkSync(other.root, path.join(t.root, "releases", "9-eeeeeeeeeeee"));
  pruneReleases(t.root, [t.ref(t.names[1])]);
  expect(fs.existsSync(path.join(other.root, "backups", "data.sqlite"))).toBe(true);
  expect(fs.lstatSync(path.join(t.root, "releases", "9-eeeeeeeeeeee")).isSymbolicLink()).toBe(true);
});
