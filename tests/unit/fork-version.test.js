import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectForkVersion } from "../../src/lib/forkVersion.js";
const dirs = [];
afterEach(() => dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const deployed = "a".repeat(40), checkout = "b".repeat(40), origin = "c".repeat(40), upstream = "d".repeat(40);
function fixture({ missingOrigin = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-version-")); dirs.push(root);
  fs.mkdirSync(path.join(root, ".fork"));
  fs.writeFileSync(path.join(root, ".fork/launcher.json"), JSON.stringify({ release: `${root}/.fork/releases/1234-${deployed.slice(0, 12)}/.next/standalone` }));
  const calls = [];
  const git = async args => {
    calls.push(args);
    if (args[0] === "rev-parse") return args[1] === "HEAD" ? checkout : deployed;
    if (args[0] === "ls-remote") { if (missingOrigin && args[1] === "origin") throw Error("private remote details"); return `${args[1] === "origin" ? origin : upstream}\trefs/heads/master`; }
    if (args[0] === "cat-file") throw Error("object not local yet");
    if (args[0] === "fetch") return "";
    if (args[0] === "show") return '{"version":"0.5.104"}';
    if (args[0] === "rev-list") return args.at(-1).endsWith(origin) ? "4\t0" : "3\t2";
    throw Error("unexpected command");
  };
  return { root, git, calls };
}
describe("fork Git version comparison", () => {
  it("compares the running release and preserves custom commits", async () => {
    const f = fixture(), result = await inspectForkVersion(f.root, f.git);
    expect(result.currentSha).toBe(deployed);
    expect(result.localChangesNotDeployed).toBe(true);
    expect(result.origin).toMatchObject({ status: "up-to-date", ahead: 4, behind: 0 });
    expect(result.upstream).toMatchObject({ status: "behind", ahead: 3, behind: 2 });
    expect(result.hasUpdate).toBe(true);
    expect(f.calls.filter(x => x[0] === "rev-list").every(x => x.at(-1).startsWith(deployed + "..."))).toBe(true);
  });
  it("downloads missing objects without writing refs, merging or deploying", async () => {
    const f = fixture(); await inspectForkVersion(f.root, f.git);
    const fetches = f.calls.filter(x => x[0] === "fetch");
    expect(fetches).toHaveLength(2);
    expect(fetches.every(x => x.includes("--no-write-fetch-head") && /^[a-f0-9]{40}$/.test(x.at(-1)))).toBe(true);
    expect(f.calls.some(x => ["merge", "reset", "push", "checkout"].includes(x[0]))).toBe(false);
  });
  it("marks an unreachable remote unknown without leaking errors", async () => {
    const f = fixture({ missingOrigin: true }), result = await inspectForkVersion(f.root, f.git);
    expect(result.origin.status).toBe("unknown");
    expect(result.upstream.status).toBe("behind");
    expect(JSON.stringify(result)).not.toContain("private remote details");
  });
  it("does not guess the deployed commit if launcher metadata is missing", async () => {
    const f = fixture(); fs.unlinkSync(path.join(f.root, ".fork/launcher.json"));
    await expect(inspectForkVersion(f.root, f.git)).rejects.toThrow("Cannot identify");
    expect(f.calls).toHaveLength(0);
  });
});
