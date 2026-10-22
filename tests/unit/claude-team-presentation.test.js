import { describe, it, expect } from "vitest";
import { memberStatus, quotaDisplay, remainingResets, selectMembers, seatSummary, allPlanMembers } from "../../src/lib/claudeTeam/presentation.js";

describe("Claude Team display semantics", () => {
  it("never presents an unmeasured candidate's 100% estimate as measured quota", () => {
    const member = { ready: true, quota: { weekly: { remaining: 100 } } };
    expect(quotaDisplay(member, "weekly", true)).toMatchObject({ remaining: null, source: "unknown", label: "Not measured" });
    expect(memberStatus(member, true).label).toBe("Ready to verify");
  });
  it("distinguishes measured, estimated and unreported windows", () => {
    const m = { snapshot: { weekly: { remaining: 10 } }, quota: { weekly: { remaining: 100 } } };
    expect(quotaDisplay(m, "weekly").remaining).toBe(10);
    expect(quotaDisplay(m, "weekly", true)).toMatchObject({ remaining: 100, source: "estimated" });
    expect(quotaDisplay(m, "fable").label).toBe("Not reported");
  });
  it("labels OAuth errors before other status and filters them separately", () => {
    const m = { email: "Agent3@example.org", identityVerified: false, ready: false, error: "HTTP 401" };
    expect(memberStatus(m, true).label).toBe("Reconnect OAuth");
    expect(selectMembers([m], { filter: "ready" })).toHaveLength(0);
    expect(selectMembers([m], { filter: "auth", search: " AGENT3 " })).toHaveLength(1);
  });
  it("sorts account numbers naturally and retains server priority", () => {
    const rows = [{ email: "agent10@x", rank: 1 }, { email: "agent2@x", rank: 2 }];
    expect(selectMembers(rows, { sort: "email" })[0].email).toBe("agent2@x");
    expect(selectMembers(rows)[0].email).toBe("agent10@x");
    expect(rows[0].email).toBe("agent10@x");
  });
  it("explains global capacity including external members and reserved seats", () => {
    const data = { purchased: { team_standard: 4 }, counts: { by_seat_tier: { team_standard: 2 }, pending_invites_by_seat_tier: { team_standard: 1 } }, seated: [] };
    expect(seatSummary(data, "team_standard")).toMatchObject({ purchased: 4, used: 2, free: 1, reserved: 1, external: 2 });
    expect(seatSummary({}, "team_standard")).toEqual({ known: false });
  });
  it("does not count expired, paused or future reset grants as remaining", () => {
    const now = Date.parse("2026-10-22T06:00:00Z");
    const snapshot = { grants: [{ resets_left: 2 }, { resets_left: 1, paused: true }, { resets_left: 1, ends_at: "2026-10-21T00:00:00Z" }, { resets_left: 1, starts_at: "2026-10-23T00:00:00Z" }] };
    expect(remainingResets(snapshot, now)).toBe(2);
    expect(remainingResets(null, now)).toBeNull();
  });
});


it("never displays a Standard snapshot as a Premium balance", () => {
  const m = { targetTier: "team_tier_1", quotaConfidence: "unknown", ready: true, snapshot: { tier: "team_standard", weekly: { remaining: 2 } }, quota: null, score: null };
  expect(quotaDisplay(m, "weekly", true)).toMatchObject({ remaining: null, label: "Not measured for Premium" });
  expect(memberStatus(m, true).label).toBe("Verify after assignment");
});


it("shows an account once in All plans without inventing a cross-plan score", () => {
  const snapshot = { tier: "team_tier_1", weekly: { remaining: 10 }, fable: { remaining: 5 } };
  const shared = { id: "agent2", email: "agent2@example.org", snapshot };
  const standard = { ...shared, targetTier: "team_standard", rank: 1, ready: true, quotaConfidence: "unknown", score: null, quotaSnapshot: null };
  const premium = { ...shared, targetTier: "team_tier_1", rank: 11, ready: false, quotaConfidence: "blocked", score: 10, quotaSnapshot: snapshot };
  const rows = allPlanMembers({ team_standard: [standard], team_tier_1: [premium] });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ allPlans: true, ready: true, targetTier: null, score: null });
  expect(rows[0].plans).toEqual([standard, premium]);
  expect(quotaDisplay(rows[0], "weekly", true)).toMatchObject({ remaining: 10, source: "historical" });
  expect(quotaDisplay(standard, "weekly", true).remaining).toBeNull();
  expect(memberStatus(rows[0], true).label).toBe("See eligibility by plan");
});

it("sorts All plans by eligibility then natural email without altering source ranks", () => {
  const rows = [{ id: "a", email: "agent10@x", ready: true, rank: 1 }, { id: "b", email: "agent2@x", ready: true, rank: 2 }, { id: "c", email: "agent1@x", ready: false, rank: 3 }];
  expect(allPlanMembers({ team_standard: rows }).map(m => m.id)).toEqual(["b", "a", "c"]);
  expect(rows[0].rank).toBe(1);
  expect(allPlanMembers()).toEqual([]);
});
