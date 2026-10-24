// Shared by the supervisor and the detached updater; no application dependencies.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (data) => { body += data; });
      res.on("end", () => { try { resolve(res.statusCode === 200 && JSON.parse(body).ok === true); } catch { resolve(false); } });
    });
    req.on("error", () => resolve(false)); req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitHealthy(port, alive, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until && alive()) { if (await health(port)) return true; await delay(300); }
  return false;
}
function freePort(port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on("error", reject);
    server.listen(port, "127.0.0.1", () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
  });
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const until = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // Do not start the replacement until the previous listener has exited.
  if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
}
module.exports = { atomicJson, readJson, health, delay, waitHealthy, freePort, stopChild };
