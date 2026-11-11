import { randomUUID } from "node:crypto";
import { SEAT_TIERS, parseQuota, ready, rankCandidates, decideAction, nextReadyAt, spareSeats, recordTierQuota, invalidateOtherTiers } from "./policy";

// All mutations pass through this worker. store.set must finish before a remote
// write: after a crash the next worker reconciles the durable intent first.
export async function runTeamCycle({ config, state, store, client, connections, updateConnection, now = Date.now(), inspect = false, onlyConnectionId = null, manual = null, survey = null, recoverOnly = false }) {
  state = { members: {}, history: [], ...state };
  if ((manual || survey) && state.pending) throw new Error("Recover the pending transaction before starting another rotation");
  const save = () => store.set("state", state);
  const progress = async (phase, account = null) => { state.worker = { ...state.worker, phase, account, updatedAt: new Date().toISOString() }; await save(); };
  const quotaSummary = (snapshot) => Object.fromEntries(["session", "weekly", "fable"].filter((key) => snapshot?.[key]).map((key) => [key, { remaining: snapshot[key].remaining, resetAt: snapshot[key].resetAt }]));
  const event = async (type, details) => {
    state.history.unshift({ id: randomUUID(), at: new Date().toISOString(), type, ...details });
    state.history = state.history.slice(0, 1000); await save();
  };
  const account = await client.account();
  const membership = account.memberships?.find((m) => m.organization?.uuid === config.orgId);
  if (!membership || !["admin", "owner", "primary_owner"].includes(membership.role)) throw new Error("Session has no admin permission in selected organization");
  const admin = connections.find((c) => c.id === config.adminConnectionId);
  if (!admin) throw new Error("Select a Claude OAuth admin account");
  const adminProfile = await client.profile(admin);
  if (adminProfile.account?.uuid !== account.uuid || adminProfile.organization?.uuid !== config.orgId) throw new Error("Session identity or organization does not match selected admin");
  state.admin = { email: account.email_address, role: membership.role, orgName: membership.organization.name };
  state.subscription = await client.subscription(config.orgId);
  state.counts = await client.counts(config.orgId);
  for (const tier of SEAT_TIERS) spareSeats(state.subscription, state.counts, tier);
  let remote = await client.members(config.orgId);
  const matched = [];
  const displayed = new Set();
  state.excluded = [];
  for (const connection of connections) {
    let memberState = state.members[connection.id] || {};
    try {
      // A profile remains readable without a seat. Never authorize a mutation
      // from a display name/email alone (names in this database are editable).
      const profile = connection.id === admin.id ? adminProfile : await client.profile(connection);
      if (profile.organization?.uuid !== config.orgId) { state.excluded.push({ id: connection.id, name: connection.name, reason: "Different organization" }); continue; }
      const member = remote.find((m) => m.account?.uuid === profile.account?.uuid);
      if (!member) throw new Error("Profile is not a member of selected organization");
      memberState = { ...memberState, id: connection.id, memberId: member.account.uuid,
        email: profile.account.email || member.account.email_address, seatTier: member.seat_tier,
        hasReceivedSeat: memberState.hasReceivedSeat || Boolean(connection.lastUsedAt) || (SEAT_TIERS.includes(member.seat_tier) && !(state.pending?.type === "quota-survey" && state.pending.targetId === connection.id)),
        error: null, identityVerified: true, verifiedAt: new Date(now).toISOString() };
      invalidateOtherTiers(memberState, member.seat_tier);
      state.members[connection.id] = memberState;
      displayed.add(connection.id);
      matched.push({ ...memberState, connection });
    } catch (e) {
      // Membership data is enough to DISPLAY an account whose OAuth expired,
      // but never enough to authorize seat/reset/routing mutations for it.
      const email = String(connection.email || connection.name || "").trim().toLowerCase();
      const member = remote.find((m) => String(m.account?.email_address || "").trim().toLowerCase() === email);
      if (member) {
        state.members[connection.id] = { ...memberState, id: connection.id, memberId: member.account.uuid,
          email: member.account.email_address, seatTier: member.seat_tier,
          hasReceivedSeat: memberState.hasReceivedSeat || Boolean(connection.lastUsedAt) || (SEAT_TIERS.includes(member.seat_tier) && !(state.pending?.type === "quota-survey" && state.pending.targetId === connection.id)),
          identityVerified: false, error: e.message };
        displayed.add(connection.id);
      } else state.excluded.push({ id: connection.id, name: connection.name, reason: e.message });
    }
  }
  // Deleted connections never remain eligible because of an old cached profile.
  state.visibleIds = [...displayed];
  state.lastCheckedAt = new Date(now).toISOString();
  state.error = null;
  await save();

  const locate = (id) => remote.find((m) => m.account?.uuid === id);
  const refreshRemote = async () => {
    remote = await client.members(config.orgId);
    state.counts = await client.counts(config.orgId);
    state.subscription = await client.subscription(config.orgId);
    for (const m of matched) {
      const tier = locate(m.memberId)?.seat_tier;
      if (tier) {
        m.seatTier = state.members[m.id].seatTier = tier;
        invalidateOtherTiers(state.members[m.id], tier);
        m.snapshotsByTier = state.members[m.id].snapshotsByTier;
      }
    }
    await save();
  };
  const assign = async (member, tier) => {
    // Re-read paid capacity immediately before each assignment, including rollback.
    const expectedTier = member.seatTier;
    await refreshRemote();
    const current = locate(member.memberId)?.seat_tier;
    if (current === tier) return;
    if (!current) throw new Error("Member disappeared during seat change");
    if (tier === "unassigned" && current !== expectedTier) throw new Error("Seat changed outside worker; refusing to remove it");
    if (tier !== "unassigned") {
      if (current !== "unassigned") throw new Error("Refusing to change an externally assigned seat");
      if (spareSeats(state.subscription, state.counts, tier) < 1) throw new Error("No verified prepaid seat available");
    }
    let failure;
    try { await client.setSeat(config.orgId, member.memberId, tier); } catch (e) { failure = e; }
    // A timed-out PUT may already have applied. Never blindly send it again.
    await refreshRemote();
    if (locate(member.memberId)?.seat_tier !== tier) throw failure || new Error("Seat change was not confirmed");
  };
  const measure = async (member, forceRefresh = false) => {
    const tier = member.seatTier;
    const snapshot = parseQuota(await client.usage(member.connection, { forceRefresh }));
    const current = (await client.members(config.orgId)).find((m) => m.account?.uuid === member.memberId);
    if (current?.seat_tier !== tier || !SEAT_TIERS.includes(tier)) throw new Error("Seat tier changed while measuring quota; refresh before rotating");
    Object.assign(state.members[member.id], recordTierQuota(state.members[member.id], tier, snapshot));
    member.snapshot = state.members[member.id].snapshot;
    member.snapshotsByTier = state.members[member.id].snapshotsByTier;
    state.members[member.id].error = null;
    await save(); return member.snapshot;
  };
  const activate = (m) => updateConnection(m.id, { isActive: true, testStatus: "active" });
  const deactivate = (m) => updateConnection(m.id, { isActive: false });
  const finishTransfer = async (source, target, tier, recovered = false) => {
    // Release source routing before exposing the verified replacement.
    if (source) await deactivate(source);
    await activate(target);
    state.members[target.id].hasReceivedSeat = true;
    const intent = state.pending;
    const mode = intent?.mode || "automatic";
    state.pending = null;
    await event("seat-transferred", { from: source?.email || null, to: target.email, tier, recovered, mode, candidateQuotaConfidence: intent?.candidateQuotaConfidence, previousMeasuredTier: intent?.previousMeasuredTier, reason: intent?.reason, quotaBefore: intent?.quotaBefore, quotaAfter: quotaSummary(target.snapshot) });
  };

  // A survey always returns the borrowed seat, even when the candidate has
  // excellent quota. This intent must never be recovered as a rotation.
  const restoreSurveySeat = async (pending) => {
    await progress("returning-borrowed-seat");
    const source = matched.find((m) => m.id === pending.sourceId);
    const target = matched.find((m) => m.id === pending.targetId);
    if (pending.orgId !== config.orgId || !source || !target) throw new Error("Borrowed seat identity missing; manual reconciliation required");
    await refreshRemote();
    if (!["unassigned", pending.tier].includes(source.seatTier) || !["unassigned", pending.tier].includes(target.seatTier) ||
        (source.seatTier === pending.tier && target.seatTier === pending.tier)) throw new Error("Borrowed seat changed outside worker; manual reconciliation required");
    await deactivate(target);
    if (target.seatTier === pending.tier) await assign(target, "unassigned");
    await assign(source, pending.tier);
    if (pending.sourceActive) await activate(source);
    else await deactivate(source);
    state.pending = null;
    await save();
  };

  // Inspection refreshes data only. It never consumes a grant, changes a seat,
  // toggles routing, or resolves an incomplete transaction by writing remotely.
  if (!inspect && state.pending) {
    await progress("recovering");
    const pending = state.pending;
    const target = matched.find((m) => m.id === pending.targetId);
    const source = matched.find((m) => m.id === pending.sourceId);
    if (pending.orgId !== config.orgId || (pending.sourceId && !source) || !target) throw new Error("Pending transaction identity missing; manual reconciliation required");
    if (pending.type === "quota-survey") {
      await restoreSurveySeat(pending);
      state.survey = { ...state.survey, status: "interrupted", completedAt: new Date().toISOString() };
      await event("quota-survey-interrupted", { account: source.email, tier: pending.tier, mode: "measurement", reason: "Original seat restored after interruption. Start a new measurement to check remaining accounts." });
      state.nextRunAt = new Date(Date.now() + config.intervalMinutes * 60000).toISOString();
      await save(); return state;
    }
    if (pending.type === "reset") {
      await measure(target);
      state.pending = null;
      await event("reset-reconciled", { account: target.email, requestId: pending.requestId });
      // Never repeat a possibly consumed reset in the recovery cycle.
      state.nextRunAt = new Date(now + config.intervalMinutes * 60000).toISOString();
      return state;
    }
    const targetTier = locate(target.memberId)?.seat_tier;
    const sourceTier = source && locate(source.memberId)?.seat_tier;
    if (targetTier === pending.tier && (!source || sourceTier === "unassigned")) {
      const quota = await measure(target, true);
      if (ready(quota, config.threshold)) await finishTransfer(source, target, pending.tier, true);
      else {
        await deactivate(target); await assign(target, "unassigned");
        if (source) { await assign(source, pending.tier); if (pending.sourceActive) await activate(source); }
        state.pending = null; await event("seat-rollback", { from: target.email, to: source?.email || null, tier: pending.tier, recovered: true, mode: pending.mode, reason: "Replacement quota was too low during recovery", quotaAfter: quotaSummary(quota) });
      }
    } else if (targetTier === "unassigned" && (!source || ["unassigned", pending.tier].includes(sourceTier))) {
      if (source) { await assign(source, pending.tier); if (pending.sourceActive) await activate(source); }
      state.pending = null; await event("seat-rollback", { from: target.email, to: source?.email || null, tier: pending.tier, recovered: true, mode: pending.mode, reason: "Interrupted transfer; original seat restored" });
    } else throw new Error("Seat state changed outside worker; manual reconciliation required");
  }

  // A process can stop between candidates, when the original seat is already
  // restored and no intent remains. Do not leave that scan marked as running.
  if (!inspect && !state.pending && state.survey?.status === "running") {
    state.survey = { ...state.survey, status: "interrupted", completedAt: new Date().toISOString() };
    await save();
  }

  if (recoverOnly) {
    state.nextRunAt = new Date(now + config.intervalMinutes * 60000).toISOString();
    await save(); return state;
  }

  if (survey) {
    const source = matched.find((m) => m.id === survey.sourceId);
    if (!source || !SEAT_TIERS.includes(source.seatTier) || source.seatTier !== survey.expectedTier) throw new Error("Select a verified seat holder; the borrowed seat must still match its selected plan");
    const targets = matched.filter((m) => m.seatTier === "unassigned");
    if (!targets.length) throw new Error("No verified waiting accounts to measure");
    const tier = source.seatTier;
    state.survey = { status: "running", sourceId: source.id, tier, total: targets.length,
      completed: 0, failed: 0, skipped: [...displayed].filter((id) => state.members[id].seatTier === "unassigned" && !state.members[id].identityVerified).length,
      startedAt: new Date().toISOString() };
    await save();
    for (const target of targets) {
      // Restoring between candidates makes every intent independently recoverable.
      state.pending = { type: "quota-survey", orgId: config.orgId, sourceId: source.id, targetId: target.id,
        tier, sourceActive: source.connection.isActive === true, startedAt: new Date().toISOString() };
      await progress("borrowing-seat", target.email);
      let failure;
      let measurementError;
      try {
        await deactivate(target);
        await deactivate(source);
        await assign(source, "unassigned");
        await assign(target, tier);
        await progress("measuring-waiting-quota", target.email);
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await measure(target, attempt === 0); measurementError = null; break; }
          catch (e) { measurementError = e; if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500)); }
        }
      } catch (e) { failure = e; }
      // Keep pending intact if restoration cannot be confirmed; recovery must
      // finish returning this seat before auto rotation or another survey.
      await restoreSurveySeat(state.pending);
      if (failure) throw failure;
      state.survey.completed++;
      if (measurementError) { state.survey.failed++; state.members[target.id].error = measurementError.message; }
      await event(measurementError ? "quota-survey-failed" : "quota-survey-measured", {
        account: target.email, tier, mode: "measurement", error: measurementError?.message,
        quotaAfter: measurementError ? null : quotaSummary(target.snapshot), reason: `Borrowed seat returned to ${source.email}.` });
    }
    // Refresh the holder after the final return too; never route survey targets.
    try { await measure(source, true); } catch (e) { state.members[source.id].error = e.message; }
    state.survey.status = "completed";
    state.survey.completedAt = new Date().toISOString();
    state.nextRunAt = new Date(Date.now() + config.intervalMinutes * 60000).toISOString();
    await event("quota-survey-completed", { account: source.email, tier, mode: "measurement",
      reason: `Seat returned. ${state.survey.completed - state.survey.failed} measured, ${state.survey.failed} failed, ${state.survey.skipped} skipped (OAuth).` });
    return state;
  }

  const measured = new Set();
  for (const member of matched.filter((m) => SEAT_TIERS.includes(m.seatTier))) {
    if (onlyConnectionId && member.id !== onlyConnectionId) continue;
    await progress("checking-quota", member.email);
    try { await measure(member); measured.add(member.id); }
    catch (e) { state.members[member.id].error = e.message; }
  }
  if (inspect) { await save(); return state; }
  const attempted = new Set();

  // Manual requests use the same transfer transaction, but never reset limits,
  // fill unrelated vacancies, or silently choose a different replacement.
  if (manual) {
    const source = matched.find((m) => m.id === manual.sourceId);
    const target = matched.find((m) => m.id === manual.targetId);
    if (!source || !target || source.memberId === target.memberId) throw new Error("Both accounts must have verified OAuth in this organization");
    if (!SEAT_TIERS.includes(source.seatTier) || source.seatTier !== manual.expectedTier) throw new Error("Source seat changed. Refresh and select the seat holder again");
    if (!measured.has(source.id)) throw new Error("Could not refresh source quota; no seat was changed");
    if (target.seatTier !== "unassigned") throw new Error("Replacement already has a seat. Refresh suggestions");
    if (!rankCandidates([target], config, now, source.seatTier)[0].ready) throw new Error("Replacement is no longer eligible. Refresh suggestions");
    const transferred = await transfer(source, source.seatTier, target.id);
    state.nextRunAt = new Date(Date.now() + config.intervalMinutes * 60000).toISOString();
    await save();
    if (!transferred) throw new Error("Replacement quota is too low. The original seat was restored; choose another account");
    return state;
  }

  // Keep accounts known to have no seat out of the normal routing pool.
  for (const m of matched.filter((m) => m.seatTier === "unassigned")) await deactivate(m);

  async function transfer(source, tier, selectedId = null, reason = source ? "Quota threshold reached" : "Fill a free prepaid seat") {
    const candidates = rankCandidates(matched.filter((m) => m.seatTier === "unassigned" && !attempted.has(`${tier}:${m.id}`) && (!selectedId || m.id === selectedId)), config, now, tier).filter((m) => m.ready);
    if (!candidates.length) return false; // source keeps seat when nobody can replace it
    for (const candidate of candidates.slice(0, 3)) {
      const target = matched.find((m) => m.id === candidate.id);
      attempted.add(`${tier}:${target.id}`);
      state.pending = { type: "seat", orgId: config.orgId, sourceId: source?.id || null,
        targetId: target.id, tier, candidateQuotaConfidence: candidate.quotaConfidence, previousMeasuredTier: target.snapshot?.tier || null, reason: selectedId ? "User selected this replacement" : reason, quotaBefore: quotaSummary(source?.snapshot), mode: selectedId ? "manual" : "automatic", sourceActive: source?.connection.isActive === true, startedAt: new Date().toISOString() };
      await progress("transferring-seat", target.email);
      await deactivate(target);
      if (source) { await deactivate(source); await assign(source, "unassigned"); }
      await assign(target, tier);
      await progress("verifying-replacement", target.email);
      // Allow for eventual consistency without issuing another mutation.
      let quota;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { quota = await measure(target, attempt === 0); break; }
        catch (e) { if (attempt === 2) throw e; await new Promise((resolve) => setTimeout(resolve, 1500)); }
      }
      if (ready(quota, config.threshold)) { await finishTransfer(source, target, tier); return true; }
      await deactivate(target); await assign(target, "unassigned");
      await event("candidate-exhausted", { account: target.email, from: source?.email || null, to: target.email, tier, mode: selectedId ? "manual" : "automatic", reason: `Actual quota did not exceed ${config.threshold}% in every required window`, quotaAfter: quotaSummary(quota) });
      // Restore source between attempts so every durable intent stands alone.
      if (source) { await assign(source, tier); if (state.pending.sourceActive) await activate(source); }
      state.pending = null; await save();
      await event("seat-rollback", { from: target.email, to: source?.email || null, tier, mode: selectedId ? "manual" : "automatic", reason: source ? "Replacement quota too low; original seat restored" : "Replacement quota too low; prepaid seat left free" });
    }
    return false;
  }

  for (const m of matched.filter((m) => measured.has(m.id))) {
    let action = decideAction(m.snapshot, config, now);
    if (action.type === "reset") {
      await progress("resetting-limits", m.email);
      const before = m.snapshot;
      const requestId = randomUUID();
      state.pending = { type: "reset", orgId: config.orgId, targetId: m.id, grantId: action.grantId, requestId };
      await save();
      let resetError;
      try { await client.reset(m.connection, config.orgId, action.grantId, requestId); }
      catch (e) { resetError = e; }
      // Always read after POST, including a lost/ambiguous response.
      await measure(m);
      const longKeys = ["weekly", "fable"].filter((key) => before[key]);
      const confirmed = longKeys.every((key) => m.snapshot[key] && m.snapshot[key].remaining > config.threshold && m.snapshot[key].remaining >= before[key].remaining) &&
        longKeys.some((key) => m.snapshot[key].remaining > before[key].remaining);
      if (confirmed) {
        state.members[m.id].snapshotsByTier = { [m.seatTier]: state.members[m.id].snapshot };
        m.snapshotsByTier = state.members[m.id].snapshotsByTier;
      }
      state.pending = null;
      await event(confirmed ? "limit-reset" : "reset-unconfirmed", { account: m.email, grantId: action.grantId, requestId, error: resetError?.message || null, reason: confirmed ? "Quota increase confirmed after reset" : "Quota reset could not be confirmed", quotaBefore: quotaSummary(before), quotaAfter: quotaSummary(m.snapshot) });
      action = confirmed ? decideAction(m.snapshot, config, now) : { type: "rotate", reason: "Reset not confirmed" };
    }
    if (action.type === "rotate") await transfer(m, m.seatTier, null, action.reason);
  }
  // Fill paid empty seats only after handling exhausted holders. Members outside
  // 9router count against capacity but are never mutation targets.
  for (const tier of SEAT_TIERS) {
    await refreshRemote();
    let vacancies = Math.max(0, spareSeats(state.subscription, state.counts, tier));
    while (vacancies-- > 0) { if (!await transfer(null, tier)) break; }
  }
  const waiting = matched.filter((m) => m.seatTier === "unassigned");
  const resetTimes = SEAT_TIERS.filter((tier) => (state.subscription?.seat_tier_quantities?.[tier] || 0) > 0)
    .map((tier) => nextReadyAt(waiting, config.threshold, now, tier)).filter(Boolean).map(Date.parse).filter((time) => time > now + 5000);
  const resetTime = resetTimes.length ? new Date(Math.min(...resetTimes)).toISOString() : null;
  const regular = now + config.intervalMinutes * 60000;
  state.nextRunAt = new Date(resetTime && Date.parse(resetTime) > now + 5000 ? Math.min(regular, Date.parse(resetTime)) : regular).toISOString();
  await save(); return state;
}
