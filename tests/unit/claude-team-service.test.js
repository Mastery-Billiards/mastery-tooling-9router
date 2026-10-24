import { afterEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => {
  const values = new Map();
  const connections = [{ id: "admin", provider: "claude", authType: "oauth", name: "admin@example.org" }, { id: "member", provider: "claude", authType: "oauth", name: "member@example.org" }];
  const client = {
    account: vi.fn(async () => ({ uuid: "admin", email_address: "admin@example.org", memberships: [{ role: "primary_owner", organization: { uuid: "71f09ff4-2c3e-44da-91de-7917610a646d", name: "Example" } }] })),
    profile: vi.fn(async (c) => ({ account: { uuid: c.id, email: c.name }, organization: { uuid: "71f09ff4-2c3e-44da-91de-7917610a646d" } })),
    subscription: vi.fn(async () => ({ status: "active", seat_tier_quantities: { team_standard: 3, team_tier_1: 3 } })),
    counts: vi.fn(async () => ({ total: 2, by_seat_tier: { team_tier_1: 1, unassigned: 1 }, pending_invites_total: 0 })),
    members: vi.fn(async () => [{ account: { uuid: "admin", email_address: "admin@example.org" }, seat_tier: "team_tier_1" }, { account: { uuid: "member", email_address: "member@example.org" }, seat_tier: "unassigned" }]),
    usage: vi.fn(async () => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } })),
    setSeat: vi.fn(), reset: vi.fn(),
  };
  return { values, connections, client, update: vi.fn() };
});
vi.mock("@/lib/localDb", () => ({ getProviderConnections: async () => mock.connections, updateProviderConnection: mock.update }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => null }));
vi.mock("../../src/lib/claudeTeam/store", () => ({
  teamStore: { get: async (key, fallback) => structuredClone(mock.values.get(key) ?? fallback), set: async (key, value) => mock.values.set(key, structuredClone(value)) },
  saveSession: vi.fn(), loadSession: () => "test-saved-session", acquireTeamLock: async () => () => {},
}));
vi.mock("../../src/lib/claudeTeam/client", () => ({ createTeamClient: () => mock.client }));
import { configureTeam, checkTeam } from "../../src/lib/claudeTeam/service.js";
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); mock.values.clear(); });
describe("saving Claude Team settings", () => {
  it("allows manual validation and recovery with automation off while rejecting an automatic run", async () => {
    vi.useFakeTimers();
    await configureTeam({ config: { adminConnectionId: "admin", orgId: "71f09ff4-2c3e-44da-91de-7917610a646d" } });
    await expect(checkTeam({ inspect: false })).rejects.toThrow("Enable automatic rotation first");
    await expect(checkTeam({ inspect: false, manual: { sourceId: "admin", targetId: "missing", expectedTier: "team_tier_1" } })).rejects.toThrow("verified OAuth");
    expect(mock.values.get("state").history[0]).toMatchObject({ type: "operation-failed", mode: "manual" });
    const view = await checkTeam({ inspect: false, recoverOnly: true });
    expect(view.config.enabled).toBe(false);
    expect(view.pending).toBeNull();
    expect(mock.client.setSeat).not.toHaveBeenCalled();
  });
  it("loads actual membership and quota on save without enabling or mutating seats", async () => {
    vi.useFakeTimers();
    const view = await configureTeam({ config: { adminConnectionId: "admin", orgId: "71f09ff4-2c3e-44da-91de-7917610a646d" } });
    expect(view.seated).toHaveLength(1); expect(view.waiting).toHaveLength(1);
    expect(view.candidatesByTier.team_standard[0]).toMatchObject({ targetTier: "team_standard", score: null, quotaConfidence: "unknown" });
    expect(view.candidatesByTier.team_tier_1[0]).toMatchObject({ targetTier: "team_tier_1", score: null, quotaConfidence: "unknown" });
    expect(view.lastCheckedAt).toBeTruthy(); expect(view.admin.email).toBe("admin@example.org");
    expect(view.config.enabled).toBe(false);
    expect(mock.client.setSeat).not.toHaveBeenCalled(); expect(mock.client.reset).not.toHaveBeenCalled(); expect(mock.update).not.toHaveBeenCalled();
  });
});
