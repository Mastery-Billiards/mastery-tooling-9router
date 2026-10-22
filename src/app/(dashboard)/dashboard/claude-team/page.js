"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/shared/components/Button";

const field = "rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm w-full";
const panel = "rounded-xl border border-border-subtle bg-bg-secondary p-5 space-y-4";
const date = (value) => value ? new Date(value).toLocaleString() : "—";
const tier = (value) => value === "team_tier_1" ? "Premium" : value === "team_standard" ? "Standard" : "No seat";

function Quota({ quota, estimated }) {
  if (!quota) return <span className="text-text-muted">—</span>;
  const value = quota.remaining;
  const color = value <= 5 ? "bg-red-500" : value < 20 ? "bg-amber-500" : "bg-emerald-500";
  return <div className="min-w-28 space-y-1" title={`Reset: ${date(quota.resetAt)}${estimated ? " · Estimated from last measurement" : ""}`}>
    <span className="text-sm tabular-nums">{estimated ? "~" : ""}{value.toFixed(1)}% left</span>
    <div className="h-1.5 rounded bg-black/10"><div className={`h-full rounded ${color}`} style={{ width: `${value}%` }} /></div>
    <div className="text-[11px] text-text-muted">{date(quota.resetAt)}</div>
  </div>;
}

function MemberTable({ members, waiting, onCheck, busy }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-sm">
    <thead className="text-text-muted"><tr>{[waiting ? "Order / score" : "Seat", "Member", "5h", "Weekly", "Fable", "Reset credits", "Last measured", ""].map((label, i) => <th key={i} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead>
    <tbody>{members.map((m) => {
      const q = waiting ? m.quota : m.snapshot;
      return <tr key={m.id} className="border-t border-border-subtle">
        <td className="px-3 py-4">{waiting ? <><b>#{m.rank}</b> · {m.score.toFixed(1)}<div className={m.ready ? "text-emerald-500" : "text-amber-500"}>{m.ready ? "Ready to try" : "Waiting for reset"}</div>{!m.hasReceivedSeat && <div className="text-xs text-brand-500">New member priority</div>}</> : tier(m.seatTier)}</td>
        <td className="px-3 py-4"><div>{m.email}</div>{m.error && <div className="max-w-64 text-xs text-red-500">{m.error}</div>}</td>
        {["session", "weekly", "fable"].map((key) => <td className="px-3 py-4" key={key}><Quota quota={q?.[key]} estimated={waiting} /></td>)}
        <td className="px-3 py-4">{m.snapshot ? (m.snapshot.grants || []).filter((g) => !g.paused && (!g.ends_at || Date.parse(g.ends_at) > Date.now())).reduce((sum, g) => sum + (g.resets_left || 0), 0) : "—"}</td>
        <td className="px-3 py-4 text-xs text-text-muted">{date(m.snapshot?.measuredAt)}</td>
        <td className="px-3 py-4">{!waiting && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onCheck(m.id)}>Check quota</Button>}</td>
      </tr>;
    })}</tbody>
  </table>{!members.length && <p className="p-4 text-text-muted">No members to display. Save settings and check data.</p>}</div>;
}

export default function ClaudeTeamPage() {
  const [data, setData] = useState(null);
  const [config, setConfig] = useState(null);
  const [sessionKey, setSessionKey] = useState("");
  const [orgs, setOrgs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sort, setSort] = useState("priority");
  const load = useCallback(async (initial = false) => {
    const response = await fetch("/api/claude-team", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load Claude Team");
    setData(result); if (initial) setConfig(result.config);
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => load(true).catch((e) => setError(e.message)), 0);
    const timer = setInterval(() => load().catch(() => {}), 10000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [load]);
  async function action(body) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/claude-team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Request failed");
      if (body.action === "discover") { setOrgs(result.organizations); setNotice(`Session: ${result.email}. Select your Team organization.`); }
      else { setData(result); if (body.action === "configure") { setConfig(result.config); setSessionKey(""); setNotice("Settings saved."); } }
    } catch (e) { setError(e.message); await load().catch(() => {}); }
    finally { setBusy(false); }
  }
  if (!config) return <div className="p-6">{error || "Loading Claude Team…"}</div>;
  const patch = (key, value) => setConfig((c) => ({ ...c, [key]: value }));
  const waiting = [...(data.waiting || [])].sort((a, b) => sort === "email" ? a.email.localeCompare(b.email) : a.rank - b.rank);
  return <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Claude Team</h1><p className="text-sm text-text-muted">Rotate prepaid seats between verified 9router members.</p></div>
      <div className="flex gap-2"><Button variant="secondary" disabled={busy || data.running} onClick={() => action({ action: "check" })}>Check data</Button><Button disabled={busy || data.running || !data.config.enabled} onClick={() => action({ action: "run" })}>Run now</Button></div>
    </div>
    {(error || data.error) && <div role="alert" className="rounded-lg bg-red-500/10 text-red-500 p-4">{error || data.error}</div>}
    {notice && <div role="status" className="rounded-lg bg-emerald-500/10 p-4">{notice}</div>}
    {data.pending && <div className="rounded-lg bg-amber-500/10 p-4">An incomplete {data.pending.type} operation is saved. The next automatic run will reconcile it before doing new work. Use Check data to inspect first.</div>}
    <section className={panel}><h2 className="text-lg font-semibold">Admin settings</h2>
      <div className="grid md:grid-cols-3 gap-4">
        <label className="space-y-2 text-sm">Admin account<select className={field} value={config.adminConnectionId} onChange={(e) => patch("adminConnectionId", e.target.value)}><option value="">Select account</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.email || a.name}</option>)}</select></label>
        <label className="space-y-2 text-sm">Admin web sessionKey<input type="password" autoComplete="off" className={field} value={sessionKey} onChange={(e) => setSessionKey(e.target.value)} placeholder={data.sessionConfigured ? "Saved · enter to replace" : "Paste sessionKey"} /></label>
        <label className="space-y-2 text-sm">Team organization{orgs.length ? <select className={field} value={config.orgId} onChange={(e) => patch("orgId", e.target.value)}><option value="">Select organization</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.id}</option>)}</select> : <input className={field} value={config.orgId} onChange={(e) => patch("orgId", e.target.value)} placeholder="Organization UUID or discover below" />}</label>
      </div>
      <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-4">{[["threshold", "Rotate at % left"], ["resetThreshold", "Reset at % left"], ["intervalMinutes", "Check every (min)"]].map(([key, label]) => <label key={key} className="text-sm space-y-2">{label}<input type="number" min="0" max="60" className={field} value={config[key]} onChange={(e) => patch(key, Number(e.target.value))} /></label>)}
        {["fable", "weekly", "session"].map((key) => <label key={key} className="text-sm space-y-2">{key === "session" ? "5h" : key} weight<input type="number" min="0" step="0.05" className={field} value={config.weights[key]} onChange={(e) => patch("weights", { ...config.weights, [key]: Number(e.target.value) })} /></label>)}
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.expiringReset} onChange={(e) => patch("expiringReset", e.target.checked)} />Use an eligible reset expiring in 24h when weekly/Fable has less than 20% left</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.enabled} onChange={(e) => patch("enabled", e.target.checked)} />Enable automatic seat rotation and limit resets</label>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => action({ action: "configure", config, ...(sessionKey ? { sessionKey } : {}) })}>Save settings</Button><Button variant="secondary" disabled={busy || !data.sessionConfigured} onClick={() => action({ action: "discover" })}>Discover organizations</Button></div>
      <p className="text-xs text-text-muted">Save the admin and session first, discover the organization, then check data before enabling automation. New members get priority on the next seat allocation.</p>
      <div className="grid sm:grid-cols-3 gap-4 border-t border-border-subtle pt-4">
        {["team_standard", "team_tier_1"].map((key) => <div key={key}><b>{tier(key)}</b><div className="text-sm">{data.counts?.by_seat_tier?.[key] ?? "—"} used / {data.purchased?.[key] ?? "—"} purchased</div></div>)}
        <div><b>{data.counts?.total ?? "—"} organization members</b><div className="text-sm">{(data.seated?.length || 0) + (data.waiting?.length || 0)} managed · {data.admin?.email || "Admin not verified yet"}</div></div>
      </div>
      <p className="text-xs text-text-muted">Last checked: {date(data.lastCheckedAt)} · Next run: {date(data.nextRunAt)}{data.running ? " · Running…" : ""}</p>
    </section>
    <section className={panel}><h2 className="text-lg font-semibold">Accounts with seats</h2><MemberTable members={data.seated || []} busy={busy} onCheck={(id) => action({ action: "check", connectionId: id })} /></section>
    <section className={panel}><div className="flex justify-between items-center gap-3"><h2 className="text-lg font-semibold">Accounts without seats</h2><select aria-label="Sort members" className={`${field} max-w-52`} value={sort} onChange={(e) => setSort(e.target.value)}><option value="priority">Next seat priority</option><option value="email">Email</option></select></div><p className="text-xs text-text-muted">~ indicates an estimate. Actual quota is checked after receiving a seat. Missing Fable limits are omitted and weights are normalized.</p><MemberTable members={waiting} waiting busy={busy} /></section>
    {!!data.excluded?.length && <section className={panel}><h2 className="font-semibold">Accounts outside this rotation</h2>{data.excluded.map((m) => <p key={m.id} className="text-sm">{m.name}: {m.reason}</p>)}</section>}
    <section className={panel}><h2 className="text-lg font-semibold">Seat and reset history</h2><div className="max-h-96 overflow-auto space-y-3">{(data.history || []).map((event) => <div key={event.id} className="border-b border-border-subtle pb-2 text-sm"><span className="text-text-muted">{date(event.at)}</span> · <b>{event.type}</b> · {event.account || [event.from || "Empty seat", event.to].filter(Boolean).join(" → ")}{event.tier ? ` · ${tier(event.tier)}` : ""}{event.error ? ` · ${event.error}` : ""}</div>)}{!data.history?.length && <p className="text-sm text-text-muted">No seat changes or resets yet.</p>}</div></section>
  </div>;
}
