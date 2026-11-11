// Display semantics only. Selection policy remains in policy.js.
export function memberStatus(member, waiting = false) {
  if (member.identityVerified === false) return { key: "auth", label: "Reconnect OAuth", tone: "danger" };
  if (member.error) return { key: "error", label: "Quota check failed", tone: "warning" };
  if (!waiting) return { key: "seated", label: "Seat assigned", tone: "neutral" };
  if (member.allPlans && member.ready) return { key: "ready", label: "See eligibility by plan", tone: "neutral" };
  if (member.ready) return { key: "ready", label: member.quotaConfidence === "unknown" ? "Verify after assignment" : member.snapshot ? "Ready to try" : "Ready to verify", tone: "success" };
  return { key: "waiting", label: "Waiting for reset", tone: "warning" };
}

export function quotaDisplay(member, key, waiting = false) {
  if (waiting && member.allPlans) {
    const q = member.snapshot?.[key];
    if (!member.snapshot) return { remaining: null, resetAt: null, source: "unknown", label: "Not measured" };
    if (!q) return { remaining: null, resetAt: null, source: "absent", label: "Not reported" };
    return { ...q, source: "historical" };
  }
  if (waiting && member.targetTier && !member.quotaSnapshot) return { remaining: null, resetAt: null, source: "unknown", label: `Not measured for ${member.targetTier === "team_tier_1" ? "Premium" : "Standard"}` };
  if (!member.snapshot) return { remaining: null, resetAt: null, source: "unknown", label: "Not measured" };
  const quota = (waiting ? member.quota : member.snapshot)?.[key];
  if (!quota) return { remaining: null, resetAt: null, source: "absent", label: "Not reported" };
  return { ...quota, source: waiting ? "estimated" : "measured" };
}

export function remainingResets(snapshot, now = Date.now()) {
  if (!snapshot) return null;
  return (snapshot.grants || []).filter((g) => !g.paused && (!g.starts_at || Date.parse(g.starts_at) <= now) &&
    (!g.ends_at || Date.parse(g.ends_at) > now)).reduce((sum, g) => sum + Math.max(0, Number(g.resets_left) || 0), 0);
}

export function selectMembers(members, { search = "", filter = "all", sort = "priority" } = {}) {
  const query = search.trim().toLowerCase();
  const rows = members.filter((m) => String(m.email || "").toLowerCase().includes(query) &&
    (filter === "all" || memberStatus(m, true).key === filter));
  return [...rows].sort((a, b) => sort === "email" ? String(a.email).localeCompare(String(b.email), "en", { numeric: true }) : a.rank - b.rank);
}

export function seatSummary(data, tier) {
  if (!data.counts || !data.purchased) return { known: false };
  const purchased = data.purchased[tier] ?? 0;
  const used = data.counts.by_seat_tier?.[tier] ?? 0;
  const reserved = data.counts.pending_invites_by_seat_tier?.[tier] ?? 0;
  const managed = (data.seated || []).filter((m) => m.seatTier === tier).length;
  return { known: true, purchased, used, reserved, free: Math.max(0, purchased - used - reserved), external: Math.max(0, used - managed) };
}

export function recommendationReasons(member, config) {
  if (member.allPlans) return member.plans.map((plan) => `${plan.targetTier === "team_tier_1" ? "Premium" : "Standard"}: ${plan.identityVerified === false ? "Reconnect OAuth before allocation." : !plan.ready ? "Saved quota is low; waiting for reset." : plan.quotaConfidence === "unknown" ? "Quota unknown for this plan; verify after assignment." : `Estimated score ${plan.score.toFixed(1)}; actual quota is verified after assignment.`}`);
  if (member.identityVerified === false) return ["OAuth identity is unverified; excluded from allocation."];
  if (!member.ready) return [`A saved quota window for ${member.targetTier === "team_tier_1" ? "Premium" : member.targetTier ? "Standard" : "this seat"} is at or below the rotation threshold; waiting for reset.`];
  const reasons = [!member.hasReceivedSeat ? "New member: takes priority on the next allocation." : "Previously used account: ranked by weighted remaining quota."];
  if (member.quotaConfidence === "unknown") {
    reasons.push(`No current measurement for ${member.targetTier === "team_tier_1" ? "Premium" : "Standard"}. Another tier's quota is not used as this tier's balance. Verify after assignment and restore the original seat if quota is too low.`);
  } else if (!member.snapshot) reasons.push("Quota unknown. The score is provisional, not a measured 100% balance; verification after assignment is required.");
  else {
    const keys = ["fable", "weekly", "session"].filter((key) => member.quota?.[key]);
    const total = keys.reduce((sum, key) => sum + config.weights[key], 0);
    reasons.push(`Estimated score ${member.score.toFixed(1)}: ${keys.map((key) => `${key === "session" ? "5h" : key === "fable" ? "Fable" : "Weekly"} ${total ? Math.round(config.weights[key] / total * 100) : 0}% weight`).join(" · ")}.`);
  }
  if (member.targetTier) reasons.push("Known usable quota is preferred to unknown quota. New members take priority within each confidence group.");
  reasons.push("Within the same member-priority group, scores less than 5 points apart favor earlier weekly resets. Exact ties use stable account order.");
  return reasons;
}

export function automationStatus(data) {
  const phases = { "borrowing-seat": "Borrowing seat", "measuring-waiting-quota": "Measuring waiting accounts", "returning-borrowed-seat": "Returning borrowed seat", "checking-members": "Verifying membership", "checking-quota": "Reading quota", "transferring-seat": "Transferring seat", "verifying-replacement": "Verifying replacement quota", "resetting-limits": "Resetting limits", recovering: "Recovering transaction" };
  if (data.running) return { tone: "warning", label: phases[data.worker?.phase] || "Checking", detail: data.worker?.account || "Worker is running" };
  if (data.pending) return { tone: "danger", label: "Recovery required", detail: "Recover the saved transaction before starting new work." };
  if (data.error) return { tone: "danger", label: "Last check failed", detail: "Retry the check or review Settings and account authentication." };
  if (data.seated.some((m) => m.error)) return { tone: "warning", label: "Quota checks need attention", detail: "Some seated accounts could not be measured. Refresh data to retry." };
  if (!data.config.enabled) return { tone: "neutral", label: "Paused", detail: "Automatic changes are paused; manual rotation is available." };
  const exhausted = data.seated.filter((m) => ["session", "weekly", "fable"].some((key) => m.snapshot?.[key]?.remaining <= data.config.threshold));
  if (exhausted.length && exhausted.every((m) => !(data.candidatesByTier?.[m.seatTier] || data.waiting)?.some((candidate) => candidate.ready))) return { tone: "warning", label: "Waiting for quota reset", detail: "No replacement is ready. Current holders retain their seats until a usable reset or replacement is available." };
  return { tone: "success", label: "Waiting for next check", detail: "Monitoring quota and reset times; healthy seat holders keep their seats." };
}

export const activityLabel = (type) => ({ "quota-survey-measured": "Waiting quota measured", "quota-survey-failed": "Waiting quota measurement failed", "quota-survey-completed": "Waiting quota scan completed", "quota-survey-interrupted": "Borrowed seat recovered", "operation-failed": "Operation failed", "seat-transferred": "Seat transfer completed", "candidate-exhausted": "Replacement rejected", "seat-rollback": "Seat restored / assignment undone", "limit-reset": "Limits reset", "reset-unconfirmed": "Reset not confirmed", "reset-reconciled": "Reset reconciled", "oauth-reconnected": "OAuth reconnected" }[type] || type);

// Merge plan queues using their existing priority ranks, never cross-tier quota scores.
function allocationPriority(row) {
  const groups = row.plans.map((plan) => ({
    group: plan.identityVerified === false ? 3 : !plan.ready ? 2 : plan.quotaConfidence === "estimated" ? 0 : 1,
    rank: plan.rank,
  }));
  const group = Math.min(...groups.map((plan) => plan.group));
  return { group, rank: Math.min(...groups.filter((plan) => plan.group === group).map((plan) => plan.rank)) };
}
export function allPlanMembers(candidatesByTier = {}) {
  const members = new Map();
  for (const tier of ["team_standard", "team_tier_1"]) for (const candidate of candidatesByTier[tier] || []) {
    const row = members.get(candidate.id) || { ...candidate, allPlans: true, targetTier: null, score: null, plans: [] };
    row.plans.push(candidate);
    members.set(candidate.id, row);
  }
  return [...members.values()].map((row) => ({ ...row, ready: row.plans.some((plan) => plan.ready) }))
    .sort((a, b) => {
      const left = allocationPriority(a), right = allocationPriority(b);
      return left.group - right.group || left.rank - right.rank || String(a.id).localeCompare(String(b.id));
    })
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
