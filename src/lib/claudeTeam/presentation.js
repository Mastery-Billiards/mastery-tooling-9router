// Display semantics only. Selection policy remains in policy.js.
export function memberStatus(member, waiting = false) {
  if (member.identityVerified === false) return { key: "auth", label: "Reconnect OAuth", tone: "danger" };
  if (member.error) return { key: "error", label: "Quota check failed", tone: "warning" };
  if (!waiting) return { key: "seated", label: "Seat assigned", tone: "neutral" };
  if (member.ready) return { key: "ready", label: member.snapshot ? "Ready to try" : "Ready to verify", tone: "success" };
  return { key: "waiting", label: "Waiting for reset", tone: "warning" };
}

export function quotaDisplay(member, key, waiting = false) {
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
