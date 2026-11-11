import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-store-test-"));
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: testDir }));
vi.mock("@/lib/db/helpers/kvStore", () => ({ makeKv: () => ({}) }));
const { loadSession, saveSession, acquireTeamLock } = await import("../../src/lib/claudeTeam/store.js");
afterAll(() => fs.rmSync(testDir, { recursive: true, force: true }));

describe("Claude Team secrets and worker lock", () => {
  it("stores encrypted credentials outside settings and checks integrity", () => {
    expect(loadSession()).toBeNull();
    const session = "sk-ant-test-test-secret";
    saveSession(session); expect(loadSession()).toBe(session);
    const file = path.join(testDir, "claude-team", "session");
    const bytes = fs.readFileSync(file);
    expect(bytes.includes(Buffer.from(session))).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
    expect(loadSession()).toBeNull();
    expect(() => saveSession("not-a-session\r\nCookie: injected")).toThrow();
  });
  it("prevents a second worker even in the same process", async () => {
    const release = await acquireTeamLock(); expect(release).toBeTypeOf("function");
    expect(await acquireTeamLock()).toBeNull(); release();
    const next = await acquireTeamLock(); expect(next).toBeTypeOf("function"); next();
  });
});
