import { describe, it, expect } from "vitest";
import { recommendationReasons, automationStatus, activityLabel } from "../../src/lib/claudeTeam/presentation.js";
import { oauthIssue } from "../../src/lib/oauth/health.js";
import { DEFAULT_CONFIG } from "../../src/lib/claudeTeam/policy.js";

describe("Claude Team operational explanations", () => {
  it("never presents an unknown balance as measured and explains priority/ties", () => {
    const reason = recommendationReasons({ ready: true, hasReceivedSeat: false }, DEFAULT_CONFIG).join(" ");
    expect(reason).toContain("New member"); expect(reason).toContain("provisional"); expect(reason).toContain("earlier weekly resets");
  });
  it("normalizes weights when Fable is absent", () => {
    const reasons = recommendationReasons({ ready: true, hasReceivedSeat: true, snapshot: {}, quota: { weekly: {}, session: {} }, score: 50 }, DEFAULT_CONFIG).join(" ");
    expect(reasons).toContain("Weekly 70% weight"); expect(reasons).toContain("5h 30% weight"); expect(reasons).not.toContain("Fable 50%");
  });
  it("distinguishes running work, recovery, failed checks and paused automation", () => {
    const view = { config: { enabled: false }, seated: [] };
    expect(automationStatus(view).label).toBe("Paused");
    expect(automationStatus({ ...view, pending: {} }).label).toBe("Recovery required");
    expect(automationStatus({ ...view, error: "error" }).label).toBe("Last check failed");
    expect(automationStatus({ ...view, running: true, worker: { phase: "verifying-replacement" } }).label).toBe("Verifying replacement quota");
    expect(activityLabel("candidate-exhausted")).toBe("Replacement rejected");
  });
  it("shows revoked OAuth on disabled accounts but does not confuse a seat-related 403 with revoked credentials", () => {
    expect(oauthIssue({ authType: "oauth", isActive: false }, { error: "Claude API HTTP 401" })?.label).toBe("Reconnect OAuth");
    expect(oauthIssue({ authType: "oauth", lastError: "invalid_grant" })).toBeTruthy();
    expect(oauthIssue({ authType: "oauth" }, { error: "OAuth authentication is currently not allowed HTTP 403" })).toBeNull();
    expect(oauthIssue({ authType: "apikey", lastError: "401" })).toBeNull();
  });
});
