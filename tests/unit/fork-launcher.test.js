import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import runtime from "../../scripts/fork-runtime.cjs";
const { delay, stopChild } = runtime;
const root = fileURLToPath(new URL("../../", import.meta.url));
let child, dir;
afterEach(async () => { await stopChild(child); child = null; if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

async function waitFor(test) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (test()) return; await delay(50); }
  throw new Error("Supervisor fixture did not reach expected state");
}
describe("fork supervisor", () => {
  it("keeps the launcher alive while swapping healthy HTTP children", async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fork-launcher-test-")));
    fs.mkdirSync(path.join(dir, "scripts")); fs.mkdirSync(path.join(dir, ".fork"));
    fs.mkdirSync(path.join(dir, "node_modules", "@next", "env"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "@next", "env", "index.js"), "exports.loadEnvConfig=()=>{};");
    for (const name of ["fork-launcher.cjs", "fork-runtime.cjs"]) fs.copyFileSync(path.join(root, "scripts", name), path.join(dir, "scripts", name));
    for (const name of ["release-a", "release-b"]) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, "custom-server.js"), "require('http').createServer((q,s)=>s.end(JSON.stringify({ok:true}))).listen(Number(process.env.PORT),'127.0.0.1');");
    }
    fs.symlinkSync(path.join(dir, "release-a"), path.join(dir, ".fork", "current"));
    const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); }); });
    child = spawn(process.execPath, [path.join(dir, "scripts", "fork-launcher.cjs")], { env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, "data"), NINEROUTER_NO_TRAY: "1" }, stdio: "ignore" });
    const state = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, ".fork", "launcher.json"))); } catch { return {}; } };
    await waitFor(() => state().healthy);
    const before = state();
    fs.symlinkSync(path.join(dir, "release-b"), path.join(dir, ".fork", "next"));
    fs.renameSync(path.join(dir, ".fork", "next"), path.join(dir, ".fork", "current"));
    child.kill("SIGUSR2");
    await waitFor(() => state().healthy && state().release.endsWith("release-b"));
    expect(state().pid).toBe(before.pid);
    expect(state().childPid).not.toBe(before.childPid);
    expect(child.exitCode).toBeNull();
  });
});
