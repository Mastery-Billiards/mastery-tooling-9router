// Pure policy: percentages below always mean REMAINING, never utilization.
export const DEFAULT_CONFIG = {
  enabled: false, adminConnectionId: "", orgId: "", threshold: 5,
  resetThreshold: 1, expiringReset: true, intervalMinutes: 3,
  weights: { fable: 0.5, weekly: 0.35, session: 0.15 },
};
export const SEAT_TIERS = ["team_standard", "team_tier_1"];

export function normalizeConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input, weights: { ...DEFAULT_CONFIG.weights, ...input.weights } };
  for (const [key, min, max] of [["threshold", 1, 30], ["resetThreshold", 0, 5], ["intervalMinutes", 1, 60]]) {
    if (!Number.isFinite(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  if (config.resetThreshold > config.threshold) throw new Error("Reset threshold must not exceed rotation threshold");
  if (typeof config.enabled !== "boolean" || typeof config.expiringReset !== "boolean") throw new Error("Invalid toggle");
  if (typeof config.adminConnectionId !== "string" || typeof config.orgId !== "string") throw new Error("Invalid admin or organization");
  const values = Object.values(config.weights);
  if (values.length !== 3 || values.some((v) => !Number.isFinite(v) || v < 0) || values.reduce((a, b) => a + b, 0) <= 0) throw new Error("Invalid quota weights");
  return Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((k) => [k, config[k]]));
}

export function parseQuota(data, now = Date.now()) {
  const window = (used, resetAt) => ({ remaining: Math.max(0, Math.min(100, 100 - used)), resetAt: resetAt || null });
  if (!Number.isFinite(data?.five_hour?.utilization) || !Number.isFinite(data?.seven_day?.utilization)) throw new Error("Incomplete quota response");
  const scoped = data.limits?.find((x) => x.kind === "weekly_scoped" && String(x.scope?.model?.display_name).toLowerCase() === "fable");
  return {
    measuredAt: new Date(now).toISOString(),
    session: window(data.five_hour.utilization, data.five_hour.resets_at),
    weekly: window(data.seven_day.utilization, data.seven_day.resets_at),
    fable: Number.isFinite(scoped?.percent) ? window(scoped.percent, scoped.resets_at) : null,
    grants: data.cedar_ember?.eligible ? data.cedar_ember.grants || [] : [], cooldownUntil: data.cedar_ember?.cooldown_until || null,
  };
}

export function estimateQuota(snapshot, now = Date.now()) {
  const result = { ...snapshot, estimated: true };
  for (const key of ["session", "weekly", "fable"]) {
    const q = snapshot?.[key];
    result[key] = !snapshot ? { remaining: 100, resetAt: null }
      : q ? { ...q, remaining: Date.parse(q.resetAt) <= now ? 100 : q.remaining } : null;
  }
  return result;
}

export function ready(quota, threshold) {
  return Boolean(quota?.session && quota?.weekly) && [quota.session, quota.weekly, quota.fable].filter(Boolean).every((q) => q.remaining > threshold);
}

export function score(quota, weights) {
  let total = 0, sum = 0;
  for (const key of ["session", "weekly", "fable"]) {
    if (quota?.[key]) { total += quota[key].remaining * weights[key]; sum += weights[key]; }
  }
  return sum ? total / sum : 0;
}

function tierSnapshots(member) {
  return { ...(SEAT_TIERS.includes(member.snapshot?.tier) ? { [member.snapshot.tier]: member.snapshot } : {}), ...member.snapshotsByTier };
}

// Snapshots are measurements of one shared account balance under a specific
// seat tier, not independent balances. Other-tier use makes positive estimates stale.
export function recordTierQuota(member, tier, snapshot) {
  if (!SEAT_TIERS.includes(tier)) throw new Error("Cannot measure quota without a supported seat tier");
  const snapshotsByTier = Object.fromEntries(Object.entries(tierSnapshots(member)).map(([key, value]) => [key, { ...value, stale: key !== tier }]));
  const measured = { ...snapshot, tier, stale: false };
  snapshotsByTier[tier] = measured;
  return { snapshot: measured, snapshotsByTier };
}

export function invalidateOtherTiers(member, tier) {
  if (!SEAT_TIERS.includes(tier)) return;
  member.snapshotsByTier = Object.fromEntries(Object.entries(tierSnapshots(member)).map(([key, value]) => [key, key === tier ? value : { ...value, stale: true }]));
}

export function quotaForTier(member, tier, now = Date.now()) {
  if (!SEAT_TIERS.includes(tier)) throw new Error("Select a supported seat tier");
  const snapshot = member.snapshotsByTier?.[tier] || (member.snapshot?.tier === tier ? member.snapshot : null);
  const quota = snapshot ? estimateQuota(snapshot, now) : null;
  // A stale low balance remains a conservative exclusion until its reset. This
  // prevents repeated failed probes alternating tiers from reviving one another.
  return { snapshot, quota, stale: Boolean(snapshot?.stale) };
}

export function rankCandidates(members, config, now = Date.now(), targetTier = "team_standard") {
  const list = members.map((m) => {
    const assessment = quotaForTier(m, targetTier, now);
    const blocked = Boolean(assessment.quota && !ready(assessment.quota, config.threshold));
    const known = Boolean(assessment.snapshot && !assessment.stale);
    const quota = known ? assessment.quota : null;
    return { ...m, targetTier, quota, quotaSnapshot: known ? assessment.snapshot : null,
      quotaConfidence: blocked ? "blocked" : known ? "estimated" : "unknown",
      score: quota ? score(quota, config.weights) : null,
      ready: m.identityVerified !== false && !blocked };
  });
  const ranked = [];
  // Known usable balances precede probes. New-member priority remains within
  // each confidence group; unknown balances never masquerade as a score of 100.
  const groups = ["estimated", "unknown", "blocked"];
  for (const confidence of groups) for (const fresh of [true, false]) {
    const pool = list.filter((m) => (!confidence || m.quotaConfidence === confidence) && !m.hasReceivedSeat === fresh)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id));
    while (pool.length) {
      const anchor = pool[0].score;
      const split = pool.findIndex((m) => anchor !== null && m.score !== null && anchor - m.score >= 5);
      const band = pool.splice(0, split < 0 ? pool.length : split);
      band.sort((a, b) => (Date.parse(a.quota?.weekly?.resetAt) || Infinity) - (Date.parse(b.quota?.weekly?.resetAt) || Infinity) || (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id));
      ranked.push(...band);
    }
  }
  return ranked.sort((a, b) => Number(b.ready) - Number(a.ready) || Number(a.identityVerified === false) - Number(b.identityVerified === false));
}

export function needsInitialInspection(view) {
  return Boolean(view?.sessionConfigured && view.config?.adminConnectionId && view.config?.orgId &&
    !view.lastCheckedAt && !view.error && !view.running && !view.pending);
}

export function nextReadyAt(members, threshold, now = Date.now(), targetTier = null) {
  const times = members.map((m) => {
    const quota = targetTier ? quotaForTier(m, targetTier, now).quota : estimateQuota(m.snapshot, now);
    if (!quota) return now;
    const blocked = [quota.session, quota.weekly, quota.fable].filter((q) => q && q.remaining <= threshold);
    if (!blocked.length) return now;
    const resets = blocked.map((q) => Date.parse(q.resetAt));
    return resets.every(Number.isFinite) ? Math.max(...resets) : Infinity;
  });
  const next = Math.min(...times);
  return Number.isFinite(next) ? new Date(next + 2000).toISOString() : null;
}

export function decideAction(quota, config, now = Date.now()) {
  if (!quota) return { type: "unknown" };
  const lowLong = [quota.weekly, quota.fable].filter(Boolean).some((q) => q.remaining <= config.threshold);
  const resetLow = [quota.weekly, quota.fable].filter(Boolean).some((q) => q.remaining <= config.resetThreshold);
  const grants = (quota.grants || []).filter((g) => g.resets_left > 0 && !g.paused &&
    (!g.starts_at || Date.parse(g.starts_at) <= now) && (!g.ends_at || Date.parse(g.ends_at) > now) &&
    (!quota.cooldownUntil || Date.parse(quota.cooldownUntil) <= now) &&
    Array.isArray(g.clears) && g.clears.includes("seven_day"))
    .sort((a, b) => (Date.parse(a.ends_at) || Infinity) - (Date.parse(b.ends_at) || Infinity));
  const almostEmpty = [quota.weekly, quota.fable].filter(Boolean).some((q) => q.remaining < 20);
  const expiredSoon = (g) => config.expiringReset && almostEmpty && Date.parse(g.ends_at) - now < 86400000;
  const usable = grants.find((g) => g.usable_now && (resetLow || expiredSoon(g)));
  if (usable) return { type: "reset", grantId: usable.id };
  if (quota.session.remaining <= config.threshold) return { type: "rotate", reason: "5h" };
  if (lowLong && grants.some((g) => g.usable_now || (g.use_requires_limit && !resetLow))) return { type: "wait-reset" };
  // A limit-only grant must remain eligible between 1% and 0% too.
  if (lowLong && grants.some((g) => g.use_requires_limit && [quota.weekly, quota.fable].filter(Boolean).some((q) => q.remaining > 0 && q.remaining <= config.threshold))) return { type: "wait-reset" };
  return lowLong ? { type: "rotate", reason: "weekly/Fable" } : { type: "keep" };
}

export function spareSeats(subscription, counts, tier) {
  const validMap = (map) => map && typeof map === "object" && !Array.isArray(map) && Object.values(map).every((n) => Number.isInteger(n) && n >= 0);
  const purchasedMap = subscription?.seat_tier_quantities;
  const usedMap = counts?.by_seat_tier;
  if (!validMap(purchasedMap) || !SEAT_TIERS.some((key) => Object.hasOwn(purchasedMap, key)) || !validMap(usedMap)) throw new Error("Cannot verify purchased seat capacity");
  const purchased = purchasedMap[tier] ?? 0;
  // APIs may omit a tier with zero members. Accept that only when the complete
  // member count accounts for every member, not from an incomplete response.
  const used = usedMap[tier] ?? (Object.values(usedMap).reduce((a, b) => a + b, 0) === counts.total ? 0 : undefined);
  const pendingMap = counts.pending_invites_by_seat_tier;
  if (!validMap(pendingMap) && counts.pending_invites_total !== 0) throw new Error("Cannot verify pending seat reservations");
  const pending = pendingMap?.[tier] ?? 0;
  if (![purchased, used, pending].every((n) => Number.isInteger(n) && n >= 0)) throw new Error("Cannot verify purchased seat capacity");
  if (subscription.status !== "active" || subscription.pending_purchase) throw new Error("Subscription is not stable and active");
  return purchased - used - pending;
}
