import { describe, it, expect, vi } from "vitest";
import { runTeamCycle } from "../../src/lib/claudeTeam/engine.js";
import { DEFAULT_CONFIG } from "../../src/lib/claudeTeam/policy.js";

function setup({ quotaLeft = 2, vacant = 0, candidateLeft = 90, grant = null } = {}) {
  const config = { ...DEFAULT_CONFIG, enabled: true, orgId: "org", adminConnectionId: "source", expiringReset: false };
  const connections = ["source", "target"].map((id) => ({ id, isActive: id === "source", name: id, authType: "oauth" }));
  const remote = [{ account: { uuid: "source", email_address: "source@example.org" }, seat_tier: "team_tier_1" }, { account: { uuid: "target", email_address: "target@example.org" }, seat_tier: "unassigned" }, { account: { uuid: "outsider" }, seat_tier: "team_standard" }];
  const usages = (left) => ({ five_hour: { utilization: 100 - left }, seven_day: { utilization: 20 }, limits: [{ kind: "weekly_scoped", percent: 20, scope: { model: { display_name: "Fable" } } }] });
  const operations = [];
  let saved = { members: {}, history: [] };
  const store = { set: vi.fn(async (key, value) => { saved = structuredClone(value); }) };
  const client = {
    account: vi.fn(async () => ({ uuid: "source", email_address: "source@example.org", memberships: [{ role: "primary_owner", organization: { uuid: "org" } }] })),
    profile: vi.fn(async (c) => ({ account: { uuid: c.id, email: c.id + "@example.org" }, organization: { uuid: "org" } })),
    subscription: vi.fn(async () => ({ status: "active", seat_tier_quantities: { team_tier_1: 1, team_standard: 1 + vacant } })),
    counts: vi.fn(async () => ({ total: remote.length, pending_invites_total: 0, pending_invites_by_seat_tier: {}, by_seat_tier: Object.fromEntries(["team_tier_1", "team_standard", "unassigned"].map((t) => [t, remote.filter((m) => m.seat_tier === t).length])) })),
    members: vi.fn(async () => structuredClone(remote)),
    usage: vi.fn(async (c) => {
      const result = usages(c.id === "source" ? quotaLeft : candidateLeft);
      if (grant && c.id === "source") { result.five_hour.utilization = 20; result.seven_day.utilization = 99; result.cedar_ember = { eligible: true, grants: [grant] }; }
      return result;
    }),
    setSeat: vi.fn(async (org, id, tier) => {
      expect(saved.pending).toBeTruthy(); // durable intent exists before each PUT
      operations.push(["seat", id, tier]);
      remote.find((m) => m.account.uuid === id).seat_tier = tier;
    }),
    reset: vi.fn(async () => { expect(saved.pending.type).toBe("reset"); operations.push(["reset"]); }),
  };
  const updateConnection = vi.fn(async (id, patch) => { operations.push(["route", id, patch.isActive]); });
  const run = (overrides = {}) => runTeamCycle({ config, state: structuredClone(saved), store, client, connections, updateConnection, ...overrides });
  return { config, remote, client, operations, store, run, state: () => saved, connections };
}

describe("Claude Team worker", () => {
  it("inspect has no remote mutations or routing changes", async () => {
    const t = setup(); await t.run({ inspect: true });
    expect(t.operations).toEqual([]); expect(t.state().members.source.snapshot.session.remaining).toBe(2);
  });
  it("moves exactly the same prepaid tier and enables only after quota verification", async () => {
    const t = setup(); await t.run();
    expect(t.operations.filter((o) => o[0] === "seat")).toEqual([["seat", "source", "unassigned"], ["seat", "target", "team_tier_1"]]);
    expect(t.operations.at(-1)).toEqual(["route", "target", true]);
    expect(t.client.usage).toHaveBeenCalledWith(t.connections[1], { forceRefresh: true });
    expect(t.state().pending).toBeNull();
  });
  it("does not remove a holder when no candidate is eligible", async () => {
    const t = setup(); t.connections.splice(1, 1); await t.run();
    expect(t.client.setSeat).not.toHaveBeenCalled();
  });
  it("fills an existing empty Standard slot without touching external holders", async () => {
    const t = setup({ quotaLeft: 90, vacant: 1 }); await t.run();
    expect(t.operations.filter((o) => o[0] === "seat")).toEqual([["seat", "target", "team_standard"]]);
  });
  it("restores the old seat if the replacement has exhausted quota", async () => {
    const t = setup({ candidateLeft: 1 }); await t.run();
    expect(t.remote.find((m) => m.account.uuid === "source").seat_tier).toBe("team_tier_1");
    expect(t.remote.find((m) => m.account.uuid === "target").seat_tier).toBe("unassigned");
    expect(t.state().pending).toBeNull();
    expect(t.operations).not.toContainEqual(["route", "target", true]);
  });
  it("stops with durable intent after a failed assignment; next run restores source", async () => {
    const t = setup(); const original = t.client.setSeat;
    t.client.setSeat = vi.fn(async (org, id, tier) => { if (id === "target" && tier !== "unassigned") throw new Error("network"); return original(org, id, tier); });
    await expect(t.run()).rejects.toThrow("network");
    expect(t.state().pending).toBeTruthy();
    await t.run({ inspect: true }); expect(t.state().pending).toBeTruthy();
    // Recovery is tested with no new exhausted-holder rotation after rollback.
    t.client.usage = vi.fn(async () => ({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 } }));
    await t.run();
    expect(t.state().pending).toBeNull();
    expect(t.remote[0].seat_tier).toBe("team_tier_1");
  });
  it("reconciles a timed-out PUT which actually applied instead of repeating it", async () => {
    const t = setup(); const original = t.client.setSeat;
    t.client.setSeat = vi.fn(async (...args) => { await original(...args); throw new Error("lost response"); });
    await t.run(); expect(t.client.setSeat).toHaveBeenCalledTimes(2);
    expect(t.state().pending).toBeNull();
  });
  it("does not rotate on a failed current quota read", async () => {
    const t = setup(); t.client.usage.mockRejectedValue(new Error("HTTP 429")); await t.run();
    expect(t.client.setSeat).not.toHaveBeenCalled(); expect(t.state().members.source.error).toBe("HTTP 429");
  });
  it("refuses an admin session that does not match selected OAuth identity", async () => {
    const t = setup(); t.client.account.mockResolvedValue({ uuid: "wrong", memberships: [{ role: "admin", organization: { uuid: "org" } }] });
    await expect(t.run()).rejects.toThrow("does not match"); expect(t.operations).toEqual([]);
  });
  it("keeps seat after a verified reset and logs it", async () => {
    const t = setup({ grant: { id: "g", resets_left: 1, usable_now: true, clears: ["seven_day"] } });
    t.client.reset.mockImplementation(async () => { t.client.usage.mockResolvedValue({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 }, limits: [{ kind: "weekly_scoped", percent: 0, scope: { model: { display_name: "Fable" } } }] }); });
    await t.run(); expect(t.client.setSeat).not.toHaveBeenCalled();
    expect(t.state().history.some((e) => e.type === "limit-reset")).toBe(true);
  });
});
