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
  const manual = { sourceId: "source", targetId: "target", expectedTier: "team_tier_1" };
  it("manually rotates a healthy holder with automation off and leaves empty slots alone", async () => {
    const t = setup({ quotaLeft: 90, vacant: 1 }); t.config.enabled = false;
    await t.run({ manual });
    expect(t.operations.filter((o) => o[0] === "seat")).toEqual([["seat", "source", "unassigned"], ["seat", "target", "team_tier_1"]]);
    expect(t.state().history[0]).toMatchObject({ type: "seat-transferred", mode: "manual" });
    expect(t.state().history[0]).toMatchObject({ reason: "User selected this replacement", quotaBefore: { session: { remaining: 90 } }, quotaAfter: { session: { remaining: 90 } } });
    expect(t.store.set.mock.calls.some(([, value]) => value.worker?.phase === "verifying-replacement")).toBe(true);
    expect(t.state().members.target.hasReceivedSeat).toBe(true);
    expect(t.state().members.target.snapshot.session.remaining).toBe(90);
    expect(t.state().nextRunAt).toBeTruthy();
    expect(t.client.reset).not.toHaveBeenCalled();
  });
  it("refuses stale seat selection and unverified manual targets without mutations", async () => {
    const t = setup();
    await expect(t.run({ manual: { ...manual, expectedTier: "team_standard" } })).rejects.toThrow("Source seat changed");
    expect(t.operations).toEqual([]);
    t.client.profile.mockImplementation(async (c) => { if (c.id === "target") throw new Error("401"); return { account: { uuid: c.id }, organization: { uuid: "org" } }; });
    await expect(t.run({ manual })).rejects.toThrow("verified OAuth");
    expect(t.operations).toEqual([]);
  });
  it("restores the source when the selected manual target has low actual quota", async () => {
    const t = setup({ quotaLeft: 90, candidateLeft: 1 });
    await expect(t.run({ manual })).rejects.toThrow("original seat was restored");
    expect(t.remote[0].seat_tier).toBe("team_tier_1");
    expect(t.remote[1].seat_tier).toBe("unassigned");
    expect(t.state().pending).toBeNull();
    expect(t.operations).not.toContainEqual(["route", "target", true]);
    expect(t.state().history[0]).toMatchObject({ type: "seat-rollback", mode: "manual", to: "source@example.org" });
  });
  it("recovers an interrupted manual transaction with automation off without allocating other seats", async () => {
    const t = setup({ quotaLeft: 90, vacant: 1 }); t.config.enabled = false;
    const original = t.client.setSeat;
    t.client.setSeat = vi.fn(async (org, id, tier) => { if (id === "target" && tier !== "unassigned") throw new Error("network"); return original(org, id, tier); });
    await expect(t.run({ manual })).rejects.toThrow("network");
    expect(t.state().pending.mode).toBe("manual");
    const count = t.client.setSeat.mock.calls.length;
    await expect(t.run({ manual })).rejects.toThrow("Recover the pending");
    expect(t.client.setSeat).toHaveBeenCalledTimes(count);
    await t.run({ recoverOnly: true });
    expect(t.state().pending).toBeNull();
    expect(t.remote[0].seat_tier).toBe("team_tier_1");
    expect(t.remote[1].seat_tier).toBe("unassigned");
    expect(t.client.reset).not.toHaveBeenCalled();
  });
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
  it("displays a known org member with expired OAuth but never assigns a seat to it", async () => {
    const t = setup({ vacant: 1 });
    t.connections[1].name = " target@example.org ";
    const profile = t.client.profile;
    t.client.profile = vi.fn(async (c) => { if (c.id === "target") throw new Error("Claude API HTTP 401"); return profile(c); });
    await t.run();
    expect(t.state().visibleIds).toContain("target");
    expect(t.state().members.target.identityVerified).toBe(false);
    expect(t.state().members.target.error).toContain("401");
    expect(t.client.setSeat).not.toHaveBeenCalled();
    expect(t.operations).not.toContainEqual(["route", "target", true]);
    expect(t.state().excluded).toEqual([]);
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


describe("tier-aware worker transfers", () => {
  const old = (tier, left) => ({ tier, session: { remaining: left }, weekly: { remaining: left }, fable: null });
  it("promotes a Standard-exhausted candidate when actual Premium quota passes", async () => {
    const t = setup({ candidateLeft: 85 });
    await t.store.set("state", { members: { target: { snapshot: old("team_standard", 0) } }, history: [] });
    await t.run();
    expect(t.remote[1].seat_tier).toBe("team_tier_1");
    expect(t.state().members.target.snapshot.tier).toBe("team_tier_1");
    expect(t.state().members.target.snapshotsByTier.team_tier_1.session.remaining).toBe(85);
    expect(t.operations).toContainEqual(["route", "target", true]);
  });
  it("rolls back a cross-tier probe that has low actual Premium quota and blocks repeat probes", async () => {
    const t = setup({ candidateLeft: 1 });
    await t.store.set("state", { members: { target: { snapshot: old("team_standard", 0) } }, history: [] });
    await t.run();
    expect(t.remote[0].seat_tier).toBe("team_tier_1");
    expect(t.remote[1].seat_tier).toBe("unassigned");
    expect(t.state().members.target.snapshotsByTier.team_tier_1.session.remaining).toBe(1);
    const count = t.client.setSeat.mock.calls.length;
    await t.run();
    expect(t.client.setSeat).toHaveBeenCalledTimes(count);
  });
  it("retains a known exhausted Premium exclusion after Standard use", async () => {
    const t = setup({ candidateLeft: 80 });
    const premium = { ...old("team_tier_1", 0), stale: true };
    await t.store.set("state", { members: { target: { snapshot: old("team_standard", 90), snapshotsByTier: { team_tier_1: premium } } }, history: [] });
    await t.run();
    expect(t.client.setSeat).not.toHaveBeenCalled();
  });
  it("rejects measurement if the remote tier changes during the usage read", async () => {
    const t = setup(); const usage = t.client.usage;
    t.client.usage = vi.fn(async c => { const result = await usage(c); if (c.id === "source") t.remote[0].seat_tier = "team_standard"; return result; });
    await expect(t.run({ manual: { sourceId: "source", targetId: "target", expectedTier: "team_tier_1" } })).rejects.toThrow("Could not refresh source quota");
    expect(t.state().members.source.snapshot).toBeUndefined();
    expect(t.client.setSeat).not.toHaveBeenCalled();
  });
});


it("can reject an account for Premium yet verify it for a free Standard seat in the same cycle", async () => {
  const t = setup({ vacant: 1 });
  const originalUsage = t.client.usage;
  t.client.usage = vi.fn(async c => {
    if (c.id !== "target") return originalUsage(c);
    const tier = t.remote.find(m => m.account.uuid === "target").seat_tier;
    return { five_hour: { utilization: tier === "team_tier_1" ? 99 : 10 }, seven_day: { utilization: 20 } };
  });
  await t.run();
  expect(t.remote[0].seat_tier).toBe("team_tier_1");
  expect(t.remote[1].seat_tier).toBe("team_standard");
  expect(t.state().members.target.snapshotsByTier.team_tier_1.session.remaining).toBe(1);
  expect(t.state().members.target.snapshotsByTier.team_tier_1.stale).toBe(true);
  expect(t.state().members.target.snapshotsByTier.team_standard.session.remaining).toBe(90);
  expect(t.operations.at(-1)).toEqual(["route", "target", true]);
});


describe("borrowed-seat quota scans", () => {
  const survey = { sourceId: "source", expectedTier: "team_tier_1" };
  it("measures all verified waiting accounts, returns the seat between targets and preserves priority flags", async () => {
    const t = setup({ quotaLeft: 90 }); t.config.enabled = false;
    t.connections.push({ id: "second", isActive: false });
    t.remote.push({ account: { uuid: "second", email_address: "second@example.org" }, seat_tier: "unassigned" });
    await t.run({ survey });
    expect(t.operations.filter(o => o[0] === "seat")).toEqual([
      ["seat", "source", "unassigned"], ["seat", "target", "team_tier_1"],
      ["seat", "target", "unassigned"], ["seat", "source", "team_tier_1"],
      ["seat", "source", "unassigned"], ["seat", "second", "team_tier_1"],
      ["seat", "second", "unassigned"], ["seat", "source", "team_tier_1"],
    ]);
    expect(t.state().survey).toMatchObject({ status: "completed", completed: 2, failed: 0, skipped: 0 });
    for (const id of ["target", "second"]) {
      expect(t.state().members[id].snapshotsByTier.team_tier_1.session.remaining).toBe(90);
      expect(t.state().members[id].seatTier).toBe("unassigned");
      expect(t.state().members[id].hasReceivedSeat).toBe(false);
      expect(t.operations).not.toContainEqual(["route", id, true]);
    }
    expect(t.state().pending).toBeNull();
    expect(t.remote[0].seat_tier).toBe("team_tier_1");
    expect(t.operations.at(-1)).toEqual(["route", "source", true]);
    expect(t.client.reset).not.toHaveBeenCalled();
  });
  it("returns the borrowed seat even when quota reads fail", async () => {
    const t = setup();
    t.client.usage.mockImplementation(async c => { if (c.id === "target") throw new Error("quota unavailable"); return { seven_day: { utilization: 20 } }; });
    await t.run({ survey });
    expect(t.state().survey).toMatchObject({ status: "completed", completed: 1, failed: 1 });
    expect(t.state().members.target.error).toBe("quota unavailable");
    expect(t.state().pending).toBeNull();
    expect(t.remote[0].seat_tier).toBe("team_tier_1");
  });
  it("recovers a crash by returning even a healthy target's seat, never completing a rotation", async () => {
    const t = setup(); const original = t.client.setSeat;
    t.client.setSeat = vi.fn(async (org, id, tier) => { if (id === "target" && tier === "unassigned") throw new Error("network"); return original(org, id, tier); });
    await expect(t.run({ survey })).rejects.toThrow("network");
    expect(t.state().pending.type).toBe("quota-survey");
    await expect(t.run({ survey })).rejects.toThrow("Recover the pending");
    t.client.setSeat = original;
    await t.run({ inspect: true });
    expect(t.state().members.target.hasReceivedSeat).toBe(false);
    await t.run();
    expect(t.state().pending).toBeNull();
    expect(t.state().survey.status).toBe("interrupted");
    expect(t.remote[0].seat_tier).toBe("team_tier_1");
    expect(t.remote[1].seat_tier).toBe("unassigned");
    expect(t.operations).not.toContainEqual(["route", "target", true]);
    expect(t.state().history.some(e => e.type === "seat-transferred")).toBe(false);
  });
  it("validates the chosen tier before mutation and preserves inactive lender routing", async () => {
    const t = setup();
    await expect(t.run({ survey: { ...survey, expectedTier: "team_standard" } })).rejects.toThrow("Select a verified seat holder");
    expect(t.operations).toEqual([]);
    t.connections[0].isActive = false;
    await t.run({ survey });
    expect(t.operations).not.toContainEqual(["route", "source", true]);
    expect(t.operations.at(-1)).toEqual(["route", "source", false]);
  });
  it("skips unverified OAuth accounts and does not mutate without verified targets", async () => {
    const t = setup(); t.connections[1].name = "target@example.org";
    const profile = t.client.profile;
    t.client.profile = vi.fn(async c => { if (c.id === "target") throw new Error("401"); return profile(c); });
    await expect(t.run({ survey })).rejects.toThrow("No verified waiting accounts");
    expect(t.operations).toEqual([]);
  });
});


it("aborts a scan on assignment failure after restoring the lender", async () => {
  const t = setup(); const original = t.client.setSeat;
  t.client.setSeat = vi.fn(async (org, id, tier) => { if (id === "target" && tier !== "unassigned") throw new Error("assignment rejected"); return original(org, id, tier); });
  await expect(t.run({ survey: { sourceId: "source", expectedTier: "team_tier_1" } })).rejects.toThrow("assignment rejected");
  expect(t.state().pending).toBeNull();
  expect(t.remote[0].seat_tier).toBe("team_tier_1");
  expect(t.operations.at(-1)).toEqual(["route", "source", true]);
});

it("records exhausted quota without trying to rotate or consume reset grants during a scan", async () => {
  const t = setup({ quotaLeft: 1, candidateLeft: 0 });
  await t.run({ survey: { sourceId: "source", expectedTier: "team_tier_1" } });
  expect(t.state().survey).toMatchObject({ completed: 1, failed: 0 });
  expect(t.state().members.target.snapshot.session.remaining).toBe(0);
  expect(t.client.reset).not.toHaveBeenCalled();
  expect(t.remote[0].seat_tier).toBe("team_tier_1");
});
