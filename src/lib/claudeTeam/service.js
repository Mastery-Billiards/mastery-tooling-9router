import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { teamStore, saveSession, loadSession, acquireTeamLock } from "./store";
import { DEFAULT_CONFIG, normalizeConfig, rankCandidates, SEAT_TIERS } from "./policy";
import { createTeamClient } from "./client";
import { runTeamCycle } from "./engine";
import { randomUUID } from "node:crypto";

const scheduler = globalThis.__claudeTeamScheduler ??= { timer: null, running: false };
const accounts = async () => (await getProviderConnections({ provider: "claude" })).filter((c) => c.authType === "oauth");

export async function teamView() {
  const config = normalizeConfig(await teamStore.get("config", DEFAULT_CONFIG));
  const state = await teamStore.get("state", { members: {}, history: [] });
  const connections = await accounts();
  const visible = (state.visibleIds || []).map((id) => state.members[id]).filter(Boolean);
  const waiting = rankCandidates(visible.filter((m) => m.seatTier === "unassigned"), config);
  // Never return raw subscription details: they contain payment information.
  return { config, sessionConfigured: Boolean(loadSession()), running: scheduler.running,
    accounts: connections.map((c) => ({ id: c.id, name: c.name, email: c.email })),
    admin: state.admin, counts: state.counts, purchased: state.subscription?.seat_tier_quantities,
    seated: visible.filter((m) => SEAT_TIERS.includes(m.seatTier)),
    waiting: waiting.map((m, index) => ({ ...m, rank: index + 1 })),
    excluded: state.excluded || [], history: state.history || [], pending: state.pending || null,
    worker: state.worker || null, lastAutoSuccessAt: state.lastAutoSuccessAt || null,
    lastCheckedAt: state.lastCheckedAt, nextRunAt: state.nextRunAt, error: state.error || null };
}

export async function configureTeam(body) {
  const unlock = await acquireTeamLock();
  if (!unlock) throw new Error("Claude Team worker is busy");
  try {
    const current = normalizeConfig(await teamStore.get("config", DEFAULT_CONFIG));
    const config = normalizeConfig({ ...current, ...body.config });
    const state = await teamStore.get("state", {});
    const changed = config.adminConnectionId !== current.adminConnectionId || config.orgId !== current.orgId;
    if (state.pending && (changed || body.sessionKey)) throw new Error("Reconcile pending transaction before changing admin/session");
    if (config.adminConnectionId && !(await accounts()).some((c) => c.id === config.adminConnectionId)) throw new Error("Admin connection not found");
    if (config.orgId && !/^[a-f0-9-]{36}$/.test(config.orgId)) throw new Error("Invalid organization ID");
    if (body.sessionKey) saveSession(body.sessionKey.trim());
    if (config.enabled && (!config.adminConnectionId || !config.orgId || !loadSession())) throw new Error("Configure admin, organization and web session first");
    if (changed) await teamStore.set("state", { members: {}, history: state.history || [], visibleIds: [] });
    else {
      state.error = null;
      if (config.enabled && !current.enabled) state.nextRunAt = null;
      await teamStore.set("state", state);
    }
    await teamStore.set("config", config);
  } finally { unlock(); }
  startTeamScheduler();
  const view = await teamView();
  if (view.sessionConfigured && view.config.adminConnectionId && view.config.orgId) {
    try { return await checkTeam({ inspect: true }); }
    catch { return teamView(); } // settings stay saved; worker error is shown in status
  }
  return view;
}

export async function discoverTeam() {
  const session = loadSession();
  if (!session) throw new Error("Save a web sessionKey first");
  const config = await teamStore.get("config", DEFAULT_CONFIG);
  const admin = (await accounts()).find((c) => c.id === config.adminConnectionId);
  const proxy = admin ? await resolveConnectionProxyConfig(admin.providerSpecificData) : null;
  const account = await createTeamClient(session, proxy).account();
  return { email: account.email_address, organizations: (account.memberships || [])
    .filter((m) => ["admin", "owner", "primary_owner"].includes(m.role) && m.organization?.raven_type === "team")
    .map((m) => ({ id: m.organization.uuid, name: m.organization.name, role: m.role })) };
}

export async function checkTeam({ inspect = true, scheduled = false, onlyConnectionId = null, manual = null, recoverOnly = false } = {}) {
  const unlock = await acquireTeamLock();
  if (!unlock) { if (scheduled) return; throw new Error("Claude Team worker is busy"); }
  scheduler.running = true;
  let workerStarted = false;
  try {
    const config = normalizeConfig(await teamStore.get("config", DEFAULT_CONFIG));
    if (!inspect && !config.enabled && !manual && !recoverOnly) throw new Error("Enable automatic rotation first");
    if (manual && (inspect || !manual.sourceId || !manual.targetId || !SEAT_TIERS.includes(manual.expectedTier))) throw new Error("Select a seat holder and replacement account");
    const session = loadSession();
    if (!session) throw new Error("Configure admin web session first");
    const state = await teamStore.get("state", { members: {}, history: [] });
    if (scheduled && Date.parse(state.nextRunAt) > Date.now()) return;
    const connections = await accounts();
    if (onlyConnectionId && !connections.some((c) => c.id === onlyConnectionId)) throw new Error("Connection not found");
    const admin = connections.find((c) => c.id === config.adminConnectionId);
    const proxy = admin ? await resolveConnectionProxyConfig(admin.providerSpecificData) : null;
    workerStarted = true;
    state.worker = { phase: "checking-members", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: manual ? "manual" : inspect ? "inspection" : recoverOnly ? "recovery" : "automatic" };
    await teamStore.set("state", state);
    await runTeamCycle({ config, state, store: teamStore, client: createTeamClient(session, proxy), connections,
      updateConnection: updateProviderConnection, inspect, onlyConnectionId, manual, recoverOnly });
    const completed = await teamStore.get("state", {});
    completed.worker = { ...completed.worker, phase: "idle", account: null, completedAt: new Date().toISOString() };
    const quotaErrors = (completed.visibleIds || []).some((id) => SEAT_TIERS.includes(completed.members?.[id]?.seatTier) && completed.members[id].error);
    if (!inspect && !manual && !recoverOnly && !completed.pending && !quotaErrors) completed.lastAutoSuccessAt = completed.worker.completedAt;
    await teamStore.set("state", completed);
  } catch (e) {
    if (workerStarted) {
      const state = await teamStore.get("state", { members: {}, history: [] });
      state.error = e.message;
      state.history = [{ id: randomUUID(), at: new Date().toISOString(), type: "operation-failed", mode: state.worker?.kind,
        phase: state.worker?.phase, from: state.members?.[state.pending?.sourceId]?.email || null,
        to: state.members?.[state.pending?.targetId]?.email || null, account: state.pending ? null : state.worker?.account || null,
        error: e.message, reason: state.pending ? "The saved transaction must be reconciled before new work." : "No pending seat transaction is recorded." }, ...(state.history || [])].slice(0, 1000);
      state.worker = { ...state.worker, phase: "failed", failedAt: new Date().toISOString() };
      state.nextRunAt = new Date(Date.now() + 180000).toISOString();
      await teamStore.set("state", state);
    }
    if (!scheduled) throw e;
  } finally { scheduler.running = false; unlock(); }
  return teamView();
}

export function startTeamScheduler() {
  if (scheduler.timer) return;
  const tick = async () => {
    try {
      const config = await teamStore.get("config", DEFAULT_CONFIG);
      if (config.enabled) await checkTeam({ inspect: false, scheduled: true });
    } catch { /* Status is persisted by worker; do not log credentials. */ }
  };
  scheduler.timer = setInterval(tick, 1000);
  scheduler.timer.unref?.();
}
