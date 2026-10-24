import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture(mode, prepare = false, local = false, inheritedEnv = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fork-sync-test-"))); dirs.push(dir);
  fs.mkdirSync(path.join(dir, "scripts")); fs.mkdirSync(path.join(dir, "bin")); fs.mkdirSync(path.join(dir, ".fork"));
  for (const name of ["sync-upstream.mjs", "fork-runtime.cjs", "prune-releases.mjs"]) fs.copyFileSync(path.join(repo, "scripts", name), path.join(dir, "scripts", name));
  // Fake git/npm/tar processes are scoped to this temporary fixture's PATH.
  const stub = `#!${process.execPath}
const fs=require('fs'),path=require('path');
const mode=process.env.PROBE_MODE, args=process.argv.slice(2), cmd=path.basename(process.argv[1]);
fs.appendFileSync(process.env.PROBE_CALLS,cmd+' '+args.join(' ')+'\\n');
if(cmd==='git'){
 if(args[0]==='status'&&mode==='dirty') console.log('?? local-file');
 if(args[0]==='remote'&&args.length===1) console.log('origin\\nupstream');
 if(args[0]==='remote'&&args[1]==='get-url') console.log('https://github.com/decolua/9router.git');
 if(args[0]==='merge'&&args[1]!=='--abort'&&mode==='conflict') process.exit(1);
 if(args[0]==='diff') console.log('src/conflicted.js');
 if(args[0]==='rev-parse') console.log('1234567890abcdef');
 if(args[0]==='archive') fs.writeFileSync(args.find(x=>x.startsWith('--output=')).slice(9),'');
}
if(cmd==='npm') {
 for (const key of ['__NEXT_PRIVATE_STANDALONE_CONFIG','NEXT_PRIVATE_OUTPUT_TRACE_ROOT','__NEXT_PRIVATE_RENDER_WORKER','NEXT_RUNTIME']) {
  if(process.env[key]) { console.error('inherited Next runtime config: '+key); process.exit(1); }
 }
}
if(cmd==='npm'&&args[0]==='run'){
 if(mode==='build-failed') process.exit(1);
 if(mode==='missing-standalone') process.exit(0);
 const out=path.join(process.cwd(),'.next','standalone'); fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'server.js'),'// standalone entry');
 fs.writeFileSync(path.join(out,'custom-server.js'),\"require('http').createServer((q,s)=>{s.setHeader('Content-Type','application/json');s.end(JSON.stringify({ok:true}));}).listen(Number(process.env.PORT),'127.0.0.1');\");
}
`;
  for (const name of ["git", "npm", "tar"]) fs.writeFileSync(path.join(dir, "bin", name), stub, { mode: 0o755 });
  if (!prepare) fs.writeFileSync(path.join(dir, ".fork", "launcher.json"), JSON.stringify({ pid: process.pid, root: dir, healthy: true, release: "/previous" }));
  let code = 0;
  try {
    await exec(process.execPath, [path.join(dir, "scripts", "sync-upstream.mjs"), ...(prepare ? ["--prepare"] : []), ...(local ? ["--local"] : [])], {
      env: { ...process.env, ...inheritedEnv, PATH: path.join(dir, "bin") + path.delimiter + process.env.PATH, DATA_DIR: path.join(dir, "data"), PROBE_MODE: mode, PROBE_CALLS: path.join(dir, "calls") }, timeout: 15000,
    });
  } catch (e) { code = e.code; }
  return { dir, code, status: JSON.parse(fs.readFileSync(path.join(dir, ".fork", "update-status.json"))), calls: fs.readFileSync(path.join(dir, "calls"), "utf8") };
}

describe("detached fork updater", () => {
  it("stops on uncommitted files before fetching or building", async () => {
    const t = await fixture("dirty"); expect(t.code).toBe(1); expect(t.status.phase).toBe("dirty");
    expect(t.calls).not.toContain("git fetch"); expect(t.calls).not.toContain("npm ");
  });
  it("records conflict files and aborts the merge without building", async () => {
    const t = await fixture("conflict"); expect(t.code).toBe(1); expect(t.status.phase).toBe("conflict");
    expect(t.status.conflicts).toEqual(["src/conflicted.js"]); expect(t.calls).toContain("git merge --abort"); expect(t.calls).not.toContain("npm ");
  });
  it("leaves the old release selected on build failure and never pushes", async () => {
    const t = await fixture("build-failed"); expect(t.status.phase).toBe("build-failed");
    expect(fs.existsSync(path.join(t.dir, ".fork", "current"))).toBe(false); expect(t.calls).not.toContain("git push");
  });
  it("deploys local fixes without fetching or merging upstream", async () => {
    const t = await fixture("build-failed", false, true);
    expect(t.status.phase).toBe("build-failed");
    expect(t.calls).not.toContain("git fetch"); expect(t.calls).not.toContain("git merge"); expect(t.calls).not.toContain("git push");
    expect(t.calls).toContain("npm run build");
  });
  it("prepares a separate health-checked release without merging or restarting", async () => {
    const t = await fixture("ok", true); expect(t.code, JSON.stringify(t.status)).toBe(0); expect(t.status.phase).toBe("prepared");
    expect(fs.realpathSync(path.join(t.dir, ".fork", "current"))).toBe(t.status.release);
    expect(t.calls).not.toContain("git merge"); expect(t.calls).not.toContain("git push");
  });
});


it("isolates dashboard-inherited Next runtime configuration from builds and probes", async () => {
  const t = await fixture("ok", true, false, {
    __NEXT_PRIVATE_STANDALONE_CONFIG: JSON.stringify({ outputFileTracingRoot: "/old-release", distDir: ".next" }),
    NEXT_PRIVATE_OUTPUT_TRACE_ROOT: "/old-release",
    __NEXT_PRIVATE_RENDER_WORKER: "1",
    NEXT_RUNTIME: "nodejs",
  });
  expect(t.code, JSON.stringify(t.status)).toBe(0);
  expect(t.status.phase).toBe("prepared");
});

it("fails before switching the server when a build succeeds without standalone entries", async () => {
  const t = await fixture("missing-standalone", false, true);
  expect(t.status.phase).toBe("build-failed");
  expect(t.status.message).toContain("Standalone build is missing server.js");
  expect(fs.existsSync(path.join(t.dir, ".fork", "current"))).toBe(false);
  expect(t.calls).not.toContain("git push");
});
