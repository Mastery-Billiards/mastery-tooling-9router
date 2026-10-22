import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG as C, normalizeConfig, parseQuota, estimateQuota, ready, score, rankCandidates, nextReadyAt, decideAction, spareSeats, needsInitialInspection, recordTierQuota, invalidateOtherTiers } from "../../src/lib/claudeTeam/policy.js";

const now = Date.parse("2026-10-22T06:00:00Z");
const later = new Date(now + 3600000).toISOString();
const window = (remaining, resetAt = later) => ({ remaining, resetAt });
const quota = (session = 60, weekly = 60, fable = 60, grants = []) => ({ tier: "team_standard", session: window(session), weekly: window(weekly), fable: fable === null ? null : window(fable), grants });
const grant = (extra = {}) => ({ id: "g", resets_left: 1, usable_now: true, clears: ["seven_day"], ends_at: later, use_requires_limit: false, ...extra });

describe("Claude Team policy", () => {
  it("loads initial member data only for complete saved settings with no running/error/pending state", () => {
    const view = { config: { adminConnectionId: "a", orgId: "o" }, sessionConfigured: true };
    expect(needsInitialInspection(view)).toBe(true);
    for (const extra of [{ sessionConfigured: false }, { config: { adminConnectionId: "a" } }, { lastCheckedAt: later }, { running: true }, { error: "403" }, { pending: {} }]) expect(needsInitialInspection({ ...view, ...extra })).toBe(false);
  });
  it("keeps unverified or blocked members out of the next-ready order", () => {
    const rows = rankCandidates([{ id: "expired", identityVerified: false }, { id: "blocked", snapshot: quota(0, 100, 100) }, { id: "valid", hasReceivedSeat: true, snapshot: quota(60, 60, 60) }], C, now);
    expect(rows.map((m) => m.id)).toEqual(["valid", "blocked", "expired"]);
    expect(rows[2].ready).toBe(false);
  });
  it("validates configuration and never accepts arbitrary fields", () => {
    expect(normalizeConfig({ command: "bad" }).command).toBeUndefined();
    expect(() => normalizeConfig({ threshold: NaN })).toThrow();
    expect(() => normalizeConfig({ enabled: "true" })).toThrow();
    expect(() => normalizeConfig({ weights: { session: 0, weekly: 0, fable: 0 } })).toThrow();
  });
  it("reads remaining Fable from scoped limits, not percent-used", () => {
    const q = parseQuota({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, limits: [{ kind: "weekly_scoped", percent: 80, scope: { model: { display_name: "Fable" } } }] }, now);
    expect(q.session.remaining).toBe(90); expect(q.weekly.remaining).toBe(80); expect(q.fable.remaining).toBe(20);
  });
  it("does not fabricate Fable for a measured account without this limit", () => {
    expect(parseQuota({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }).fable).toBeNull();
    expect(score(quota(100, 50, null), C.weights)).toBeCloseTo(65);
  });
  it("keeps off-seat snapshots until each window resets", () => {
    const q = estimateQuota({ ...quota(2, 3, 4), session: window(2, new Date(now - 1).toISOString()) }, now);
    expect(q.session.remaining).toBe(100); expect(q.weekly.remaining).toBe(3); expect(q.fable.remaining).toBe(4);
    expect(ready(estimateQuota(null, now), 5)).toBe(true);
  });
  it("requires every applicable window to exceed the threshold", () => {
    expect(ready(quota(100, 100, 5), 5)).toBe(false);
  });
  it("prefers new members then Fable-weighted score", () => {
    const list = rankCandidates([{ id: "old", hasReceivedSeat: true, snapshot: quota(100, 100, 100) }, { id: "new", snapshot: quota(50, 50, 50) }], C, now);
    expect(list.map((m) => m.id)).toEqual(["new", "old"]);
    expect(score(quota(100, 100, 0), C.weights)).toBe(50);
  });
  it("breaks scores within 5 points by earlier weekly reset", () => {
    const a = quota(90, 90, 90), b = quota(88, 88, 88);
    b.weekly.resetAt = new Date(now + 10000).toISOString();
    expect(rankCandidates([{ id: "a", snapshot: a }, { id: "b", snapshot: b }], C, now)[0].id).toBe("b");
  });
  it("waits for the latest blocking window per candidate, then the earliest candidate", () => {
    const a = quota(1, 1, 90); a.weekly.resetAt = new Date(now + 7200000).toISOString();
    const b = quota(90, 1, 90);
    expect(Date.parse(nextReadyAt([{ snapshot: a }, { snapshot: b }], 5, now))).toBe(now + 3602000);
    b.weekly.resetAt = null;
    expect(nextReadyAt([{ snapshot: b }], 5, now)).toBeNull();
  });
  it("waits down to 1% when an eligible reset exists", () => {
    expect(decideAction(quota(50, 5, 50, [grant()]), { ...C, expiringReset: false }, now).type).toBe("wait-reset");
    expect(decideAction(quota(50, 50, 1, [grant()]), C, now).type).toBe("reset");
  });
  it("waits below 1% for limit-only grants; uses when server marks usable", () => {
    expect(decideAction(quota(50, 0.5, 50, [grant({ usable_now: false, use_requires_limit: true })]), C, now).type).toBe("wait-reset");
    expect(decideAction(quota(50, 0, 50, [grant({ use_requires_limit: true })]), C, now).type).toBe("reset");
  });
  it("does not use a reset for 5h alone or a paused/expired/cooling grant", () => {
    expect(decideAction(quota(1, 90, 90, [grant()]), C, now).type).toBe("rotate");
    for (const g of [grant({ paused: true }), grant({ ends_at: new Date(now - 1).toISOString() }), grant({ starts_at: later })]) expect(decideAction(quota(90, 1, 90, [g]), C, now).type).toBe("rotate");
    const q = quota(90, 1, 90, [grant()]); q.cooldownUntil = later;
    expect(decideAction(q, C, now).type).toBe("rotate");
  });
  it("uses an expiring eligible reset below 20% only when opted in", () => {
    expect(decideAction(quota(90, 19, 90, [grant()]), C, now).type).toBe("reset");
    expect(decideAction(quota(90, 19, 90, [grant()]), { ...C, expiringReset: false }, now).type).toBe("keep");
  });
  it("accounts for pending invites and rejects unknown paid capacity", () => {
    const subscription = { status: "active", seat_tier_quantities: { team_standard: 3 } };
    expect(spareSeats(subscription, { by_seat_tier: { team_standard: 2 }, pending_invites_by_seat_tier: { team_standard: 1 } }, "team_standard")).toBe(0);
    expect(() => spareSeats(subscription, {}, "team_standard")).toThrow();
  });
  it("supports zero-use tiers and orgs buying only one tier without guessing capacity", () => {
    const subscription = { status: "active", seat_tier_quantities: { team_standard: 3 } };
    const counts = { total: 8, by_seat_tier: { unassigned: 8 }, pending_invites_total: 0 };
    expect(spareSeats(subscription, counts, "team_standard")).toBe(3);
    expect(spareSeats(subscription, counts, "team_tier_1")).toBe(0);
    expect(() => spareSeats(subscription, { ...counts, total: 9 }, "team_standard")).toThrow();
    expect(() => spareSeats(subscription, { ...counts, pending_invites_total: 1 }, "team_standard")).toThrow();
  });
});


describe("tier-aware quota selection", () => {
  const standard = "team_standard", premium = "team_tier_1";
  const member = (id, tier, left) => ({ id, hasReceivedSeat: true, identityVerified: true, ...recordTierQuota({}, tier, quota(left, left, left)) });
  it("does not exclude a Standard-exhausted account from Premium or invent Premium percentages", () => {
    const m = member("agent7", standard, 1);
    const [std] = rankCandidates([m], C, now, standard), [prem] = rankCandidates([m], C, now, premium);
    expect(std.ready).toBe(false);
    expect(prem).toMatchObject({ ready: true, quotaConfidence: "unknown", quota: null, score: null });
  });
  it("does not reuse high Premium quota as Standard quota", () => {
    const [m] = rankCandidates([member("a", premium, 95)], C, now, standard);
    expect(m.ready).toBe(true); expect(m.quota).toBeNull(); expect(m.score).toBeNull();
  });
  it("prefers known usable target-tier quota to unknown probes, preserving new priority within each group", () => {
    const known = member("known", premium, 60), freshKnown = { ...member("new-known", premium, 40), hasReceivedSeat: false };
    const rows = rankCandidates([{ id: "new-unknown" }, known, freshKnown, { id: "unknown", hasReceivedSeat: true }], C, now, premium);
    expect(rows.map(m => m.id)).toEqual(["new-known", "known", "new-unknown", "unknown"]);
  });
  it("invalidates high estimates after another tier is assigned or measured", () => {
    const m = member("a", premium, 90);
    invalidateOtherTiers(m, standard);
    expect(rankCandidates([m], C, now, premium)[0]).toMatchObject({ ready: true, score: null, quotaConfidence: "unknown" });
    Object.assign(m, recordTierQuota(m, standard, quota(50, 50, 50)));
    expect(m.snapshot.tier).toBe(standard);
    expect(rankCandidates([m], C, now, premium)[0].quota).toBeNull();
    expect(rankCandidates([m], C, now, standard)[0].score).toBe(50);
  });
  it("keeps stale low measurements blocked until reset to avoid repeated cross-tier probes", () => {
    const m = member("a", premium, 1);
    Object.assign(m, recordTierQuota(m, standard, quota(80, 80, 80)));
    expect(rankCandidates([m], C, now, premium)[0].ready).toBe(false);
    expect(rankCandidates([m], C, now + 3600001, premium)[0]).toMatchObject({ ready: true, quotaConfidence: "unknown", score: null });
  });
  it("treats old snapshots with no measured tier as unknown for either seat", () => {
    for (const tier of [standard, premium]) expect(rankCandidates([{ id: "legacy", snapshot: { ...quota(0, 0, 0), tier: undefined } }], C, now, tier)[0]).toMatchObject({ ready: true, score: null, quota: null });
  });
  it("continues excluding invalid OAuth even when target-tier quota is unknown", () => {
    expect(rankCandidates([{ id: "auth", identityVerified: false }], C, now, premium)[0].ready).toBe(false);
  });
  it("schedules readiness using the requested tier's blocking windows", () => {
    const m = member("a", standard, 1);
    expect(Date.parse(nextReadyAt([m], 5, now, standard))).toBe(now + 3602000);
    expect(Date.parse(nextReadyAt([m], 5, now, premium))).toBe(now + 2000);
  });
});
