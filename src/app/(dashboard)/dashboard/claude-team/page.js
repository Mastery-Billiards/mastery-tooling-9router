"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/shared/components/Button";
import { needsInitialInspection } from "@/lib/claudeTeam/policy";
import { memberStatus, quotaDisplay, remainingResets, selectMembers, seatSummary } from "@/lib/claudeTeam/presentation";

const field = "rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm w-full min-w-0";
const panel = "rounded-xl border border-border-subtle bg-bg-secondary p-4 sm:p-5";
const labelClass = "flex min-w-0 flex-col justify-end gap-2 text-sm";
const providerUrl = "/dashboard/providers/claude";
const toneClass = { danger: "bg-red-500/10 text-red-500", warning: "bg-amber-500/10 text-amber-500", success: "bg-emerald-500/10 text-emerald-500", neutral: "bg-surface-2 text-text-muted" };
const date = (value, full = false) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleString(undefined, full ? {} : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
const tier = (value) => value === "team_tier_1" ? "Premium" : "Standard";

function Badge({ status }) {
  return <span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${toneClass[status.tone]}`}>{status.label}</span>;
}

function Quota({ member, name, waiting }) {
  const q = quotaDisplay(member, name, waiting);
  if (q.remaining === null) return <div className="text-xs text-text-muted" title={q.source === "unknown" ? "No quota has been measured. Actual quota is checked after a seat is assigned." : "Claude did not report a separate limit for this window."}>{q.label}</div>;
  // Match Quota Tracker's remaining-quota thresholds and light/dark colors.
  const colors = q.remaining > 70
    ? { text: "text-green-600 dark:text-green-400", bar: "bg-green-500", track: "bg-green-500/10" }
    : q.remaining >= 30
      ? { text: "text-yellow-600 dark:text-yellow-400", bar: "bg-yellow-500", track: "bg-yellow-500/10" }
      : { text: "text-red-600 dark:text-red-400", bar: "bg-red-500", track: "bg-red-500/10" };
  return <div className="min-w-0 space-y-1.5" title={`${q.source === "estimated" ? "Estimate from the last measurement" : "Measured quota"}. Reset: ${date(q.resetAt, true)}`}>
    <div className={`text-sm font-medium tabular-nums ${colors.text}`}>{q.source === "estimated" ? "~" : ""}{Math.round(q.remaining * 10) / 10}%<span className="ml-1 text-xs font-normal text-text-muted">left</span></div>
    <div className={`h-1.5 rounded ${colors.track}`} role="meter" aria-label={`${name === "session" ? "5h" : name} quota remaining for ${member.email}`} aria-valuenow={q.remaining} aria-valuemin={0} aria-valuemax={100}><div className={`h-full rounded ${colors.bar}`} style={{ width: `${Math.min(q.remaining, 100)}%` }} /></div>
    <div className="text-[11px] text-text-muted">Reset {date(q.resetAt)}</div>
  </div>;
}

function MemberIdentity({ member, waiting }) {
  const status = memberStatus(member, waiting);
  return <div className="min-w-0 space-y-1.5">
    <div className="break-all font-medium">{member.email}</div>
    <div className="flex flex-wrap items-center gap-2"><Badge status={status} />{!waiting && <span className="text-xs text-text-muted">{tier(member.seatTier)}</span>}{waiting && !member.hasReceivedSeat && member.identityVerified !== false && <span className="text-xs text-brand-500">New member</span>}</div>
    {member.error && <div className="max-w-80 text-xs text-red-500">{member.identityVerified === false ? "OAuth could not be verified. Reconnect this account before rotation." : member.error}</div>}
    {member.identityVerified === false ? <Link href={providerUrl} className="inline-block text-xs text-brand-500 underline underline-offset-2">Open Claude accounts →</Link> : <p className="text-[11px] text-text-muted">{member.snapshot ? `${waiting ? "Last measured" : "Measured"} ${date(member.snapshot.measuredAt)}` : "Quota is checked after receiving a seat"}</p>}
  </div>;
}

function Priority({ member }) {
  return member.ready ? <div className="whitespace-nowrap"><b className="text-lg">#{member.rank}</b><div className="text-xs text-text-muted" title="Weighted estimate used to select the next account; not a measured quota percentage.">Score {member.score.toFixed(1)}</div></div> : <span className="text-text-muted" title="Not eligible for the next seat allocation">—</span>;
}

function MemberList({ members, waiting = false, onCheck, busy, loaded, filtered }) {
  if (!members.length) return <p className="py-5 text-sm text-text-muted">{filtered ? "No accounts match these filters." : loaded ? waiting ? "No managed accounts are waiting for a seat." : "No managed accounts currently have a seat." : "Members appear here after admin setup and the first refresh."}</p>;
  return <>
    <div className="hidden overflow-x-auto xl:block"><table className="w-full text-left text-sm">
      <caption className="sr-only">{waiting ? "Accounts waiting for a seat, ordered by allocation priority" : "Managed accounts with assigned seats"}. All percentages show quota remaining.</caption>
      <thead className="text-text-muted"><tr>{[...(waiting ? ["Next"] : []), "Account", "5h left", "Weekly left", "Fable left", "Resets left", ...(!waiting ? ["Action"] : [])].map((text) => <th key={text} scope="col" className="px-3 py-3 font-medium whitespace-nowrap">{text}</th>)}</tr></thead>
      <tbody>{members.map((m) => <tr key={m.id} className="border-t border-border-subtle align-top">
        {waiting && <td className="px-3 py-4"><Priority member={m} /></td>}
        <td className="px-3 py-4"><MemberIdentity member={m} waiting={waiting} /></td>
        {["session", "weekly", "fable"].map((name) => <td className="px-3 py-4 min-w-28" key={name}><Quota member={m} name={name} waiting={waiting} /></td>)}
        <td className="px-3 py-4 text-text-muted">{remainingResets(m.snapshot) ?? "Not measured"}</td>
        {!waiting && <td className="px-3 py-4"><Button variant="secondary" size="sm" disabled={busy} onClick={() => onCheck(m.id)} aria-label={`Refresh quota for ${m.email}`}>Refresh</Button></td>}
      </tr>)}</tbody>
    </table></div>
    <div className="divide-y divide-border-subtle xl:hidden">{members.map((m) => <article key={m.id} className="py-4 space-y-4">
      <div className="flex gap-3 items-start">{waiting && <Priority member={m} />}<MemberIdentity member={m} waiting={waiting} /></div>
      <div className="grid grid-cols-3 gap-3">{[["session", "5h"], ["weekly", "Weekly"], ["fable", "Fable"]].map(([name, text]) => <div key={name} className="min-w-0"><div className="mb-2 text-xs text-text-muted">{text} left</div><Quota member={m} name={name} waiting={waiting} /></div>)}</div>
      <div className="flex items-center justify-between gap-2 text-xs text-text-muted"><span>Resets left: {remainingResets(m.snapshot) ?? "Not measured"}</span>{!waiting && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onCheck(m.id)} aria-label={`Refresh quota for ${m.email}`}>Refresh quota</Button>}</div>
    </article>)}</div>
  </>;
}

async function requestAction(body) {
  const response = await fetch("/api/claude-team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

export default function ClaudeTeamPage() {
  const [data, setData] = useState(null), [config, setConfig] = useState(null);
  const [sessionKey, setSessionKey] = useState(""), [orgs, setOrgs] = useState([]);
  const [operation, setOperation] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [sort, setSort] = useState("priority"), [search, setSearch] = useState(""), [filter, setFilter] = useState("all");
  const [settingsOpen, setSettingsOpen] = useState(null);
  const [manualSource, setManualSource] = useState(null), [manualTargetId, setManualTargetId] = useState("");
  const load = useCallback(async (initial = false) => {
    const response = await fetch("/api/claude-team", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "Dashboard session expired. Sign in again." : result.error || "Could not reach the server");
    setData(result); setConnectionError(""); if (initial) setConfig(result.config);
    return result;
  }, []);
  useEffect(() => {
    const initial = setTimeout(async () => {
      try {
        const view = await load(true);
        if (needsInitialInspection(view)) { setOperation("check"); setData(await requestAction({ action: "check" })); }
      } catch (e) { if (e.message !== "Claude Team worker is busy") setError(e.message); }
      finally { setOperation(""); }
    }, 0);
    const timer = setInterval(() => load().catch((e) => setConnectionError(e.message)), 10000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [load]);
  async function action(body) {
    setOperation(body.action); setError(""); setNotice("");
    try {
      const result = await requestAction(body);
      if (body.action === "discover") { setOrgs(result.organizations); setNotice(`Session belongs to ${result.email}. Select the Team organization and save.`); }
      else {
        setData(result);
        if (body.action === "configure") {
          setConfig(result.config); setSessionKey("");
          setNotice(result.error ? "Settings saved, but refreshing members failed. See the error above." : result.lastCheckedAt ? "Settings saved and members refreshed." : "Settings saved. Select an organization to finish setup.");
        } else if (body.action === "check") setNotice("Member data and quota refreshed. No seats or reset credits were changed.");
        else if (body.action === "rotate") {
          setManualSource(null); setManualTargetId("");
          setNotice("Seat transferred and replacement quota verified. Routing, history and the next automatic check are updated.");
        } else if (body.action === "recover") setNotice("Pending transaction reconciled. Review the current seats before starting another rotation.");
      }
    } catch (e) { setError(e.message); await load().catch(() => {}); }
    finally { setOperation(""); }
  }
  if (!config) return <div className="p-6" role="status">{error || "Loading Claude Team…"}</div>;
  const busy = Boolean(operation) || data.running;
  const dirty = Boolean(sessionKey.trim()) || JSON.stringify(config) !== JSON.stringify(data.config);
  const patch = (key, value) => setConfig((c) => ({ ...c, [key]: value }));
  const all = [...data.seated, ...data.waiting];
  const authIssues = all.filter((m) => m.identityVerified === false).length;
  const readyCount = data.waiting.filter((m) => m.ready).length;
  const next = data.waiting.find((m) => m.ready);
  const suggestions = data.waiting.filter((m) => m.ready);
  const source = data.seated.find((m) => m.id === manualSource?.id);
  const target = suggestions.find((m) => m.id === manualTargetId);
  const canRotate = source && source.identityVerified !== false && source.seatTier === manualSource.tier && target && !busy && !dirty && !data.pending;
  const seated = selectMembers(data.seated, { search, sort: "email" });
  const waiting = selectMembers(data.waiting, { search, filter, sort });
  const complete = Boolean(data.config.adminConnectionId && data.config.orgId && data.sessionConfigured);
  const savedOrg = data.config.orgId;
  const orgOptions = orgs.some((o) => o.id === savedOrg) || !savedOrg ? orgs : [{ id: savedOrg, name: data.admin?.orgName || "Saved organization" }, ...orgs];
  return <div className="p-4 sm:p-6 space-y-5 max-w-screen-2xl mx-auto min-w-0">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Claude Team</h1><p className="text-sm text-text-muted mt-1">Seat allocation and quota for your 9router accounts.</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" loading={busy} onClick={() => action({ action: "check" })}>{operation === "configure" ? "Saving & refreshing…" : busy ? "Loading…" : "Refresh data"}</Button><Button disabled={busy || !data.config.enabled || dirty} title={dirty ? "Save your changes first" : !data.config.enabled ? "Enable automation in admin settings first" : "Run the configured seat rotation now"} onClick={() => action({ action: "run" })}>Run auto rules</Button></div>
    </header>
    {connectionError && <div role="alert" className="rounded-lg bg-amber-500/10 p-4 text-sm">{connectionError} Showing the last loaded data. <Link href="/login" className="underline">Sign in</Link></div>}
    {(error || data.error) && <div role="alert" className="rounded-lg bg-red-500/10 text-red-500 p-4 text-sm">{error || data.error}</div>}
    {notice && <div role="status" className={`rounded-lg p-3 text-sm ${data.error ? "bg-amber-500/10" : "bg-emerald-500/10"}`}>{notice}</div>}
    <div className={`${panel} flex flex-wrap items-start justify-between gap-3`}>
      <div className="space-y-1"><Badge status={{ tone: data.config.enabled ? "success" : "neutral", label: data.config.enabled ? "Automation on" : "Automation off" }} /><p className="text-sm text-text-muted">{data.config.enabled ? `Checks every ${data.config.intervalMinutes} min · Next run ${date(data.nextRunAt)}` : "Automatic changes are paused. Refresh data or transfer a selected seat manually."}</p></div>
      <div className="text-xs text-text-muted">Last refreshed <span title={date(data.lastCheckedAt, true)}>{date(data.lastCheckedAt)}</span></div>
    </div>
    <div className="grid sm:grid-cols-3 gap-3">
      {["team_standard", "team_tier_1"].map((key) => { const s = seatSummary(data, key); return <section className={panel} key={key}><h2 className="text-sm font-medium text-text-muted">{tier(key)} · entire organization</h2><p className="mt-2 text-2xl font-semibold tabular-nums">{s.known ? `${s.used} / ${s.purchased}` : "Not loaded"}<span className="text-xs font-normal text-text-muted ml-2">{s.known ? "seats used" : ""}</span></p>{s.known && <p className="mt-2 text-xs text-text-muted"><span className={s.free ? "text-emerald-500 font-medium" : ""}>{s.free} free prepaid</span>{s.reserved ? ` · ${s.reserved} reserved` : ""}{s.external ? ` · ${s.external} used outside 9router` : ""}</p>}</section>; })}
      <section className={panel}><h2 className="text-sm font-medium text-text-muted">Managed accounts</h2><p className="mt-2 text-2xl font-semibold">{data.lastCheckedAt ? all.length : "Not loaded"}</p><p className="mt-2 text-xs text-text-muted">{data.counts ? `${data.counts.total} members in org · ${readyCount} ready to verify${authIssues ? ` · ${authIssues} need OAuth` : ""}` : "Finish admin setup to load members"}</p></section>
    </div>
    {authIssues > 0 && <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-4 text-sm flex flex-wrap justify-between items-center gap-2"><p><b>{authIssues} accounts need OAuth verification.</b> They remain visible but cannot receive a seat.</p><a href={data.seated.some((m) => m.identityVerified === false) ? "#seated-members" : "#waiting-members"} className="font-medium text-brand-500 underline" onClick={() => { setFilter("auth"); setSearch(""); }}>Review accounts →</a></div>}
    {next && <div className="rounded-lg border border-border-subtle px-4 py-3 text-sm"><span className="text-text-muted">Next candidate</span><b className="ml-2 break-all">{next.email}</b><span className="block mt-1 text-xs text-text-muted">{next.snapshot ? "Chosen using estimated quota. Actual quota is verified after assignment." : "No saved quota yet. This account is a candidate for verification, not confirmed to have full quota."}{!data.config.enabled ? " Automation is off; no allocation is scheduled." : ""}</span></div>}
    {data.pending && <div className="rounded-lg bg-amber-500/10 p-4 text-sm space-y-2"><p>An incomplete {data.pending.type} operation is saved. Recover it before starting another rotation. Automatic runs also reconcile it before new work.</p><Button variant="secondary" disabled={busy} onClick={() => action({ action: "recover" })}>Recover pending operation</Button></div>}

    <details className={panel} open={settingsOpen ?? !data.admin} onToggle={(e) => setSettingsOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none"><span className="font-semibold">Admin & automation settings</span><span className="block text-xs text-text-muted mt-1 pl-4">{data.admin ? `${data.admin.email} · ${data.admin.orgName} · verified` : "Configure the admin, web session and organization"}{dirty ? " · Unsaved changes" : ""}</span></summary>
      <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); action({ action: "configure", config, ...(sessionKey ? { sessionKey } : {}) }); }}>
        <div className="grid lg:grid-cols-3 gap-4">
          <label className={labelClass}>Admin account<select className={field} value={config.adminConnectionId} onChange={(e) => patch("adminConnectionId", e.target.value)}><option value="">Select account</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.email || a.name}</option>)}</select></label>
          <label className={labelClass}>Admin web sessionKey<input type="password" autoComplete="off" className={field} value={sessionKey} onChange={(e) => setSessionKey(e.target.value)} placeholder={data.sessionConfigured ? "Saved · enter only to replace" : "Paste sessionKey"} /></label>
          <label className={labelClass}>Team organization{orgOptions.length ? <select className={field} value={config.orgId} onChange={(e) => patch("orgId", e.target.value)}><option value="">Select organization</option>{orgOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select> : <input className={field} value={config.orgId} onChange={(e) => patch("orgId", e.target.value)} placeholder="Discover after saving the session" />}</label>
        </div>
        <div className="grid sm:grid-cols-3 gap-4">{[["threshold", "Rotate at % remaining", 1, 30], ["resetThreshold", "Use reset at % remaining", 0, 5], ["intervalMinutes", "Check interval (minutes)", 1, 60]].map(([key, label, min, max]) => <label key={key} className={labelClass}>{label}<input type="number" min={min} max={max} className={field} value={config[key]} onChange={(e) => patch(key, Number(e.target.value))} /></label>)}</div>
        <label className="flex items-start gap-2 text-sm"><input className="mt-0.5" type="checkbox" checked={config.enabled} onChange={(e) => patch("enabled", e.target.checked)} /><span>Enable automatic seat rotation and limit resets<span className="block text-xs text-text-muted mt-1">Takes effect only after saving. Uses prepaid seats only.</span></span></label>
        <details className="rounded-lg border border-border-subtle p-3"><summary className="cursor-pointer text-sm">Advanced selection & reset rules</summary><div className="pt-4 space-y-4"><div className="grid sm:grid-cols-3 gap-4">{["fable", "weekly", "session"].map((key) => <label key={key} className={labelClass}>{key === "session" ? "5h" : key === "fable" ? "Fable" : "Weekly"} priority weight (%)<input type="number" min="0" max="100" step="1" className={field} value={Math.round(config.weights[key] * 100)} onChange={(e) => patch("weights", { ...config.weights, [key]: Number(e.target.value) / 100 })} /></label>)}</div><p className="text-xs text-text-muted">Weights are normalized automatically. New members take priority on the next allocation, without displacing a healthy seat holder.</p><label className="flex items-start gap-2 text-sm"><input className="mt-0.5" type="checkbox" checked={config.expiringReset} onChange={(e) => patch("expiringReset", e.target.checked)} /><span>Use a reset expiring within 24 hours when weekly or Fable has less than 20% left.</span></label></div></details>
        <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={busy}>Save & refresh members</Button><Button type="button" variant="secondary" disabled={busy || !data.sessionConfigured} onClick={() => action({ action: "discover" })}>Discover organizations</Button>{dirty && <span className="text-xs text-amber-500" role="status">Unsaved changes</span>}</div>
        <p className="text-xs text-text-muted">First setup: save the admin and session, discover and select the organization, then save again. Refreshing data does not enable automation.</p>
      </form>
    </details>

    {!data.lastCheckedAt && complete && <div role="status" className="rounded-lg bg-amber-500/10 p-4 text-sm">{busy ? "Verifying admin and loading members…" : "Members have not loaded yet."}<Button variant="secondary" className="ml-3" disabled={busy} onClick={() => action({ action: "check" })}>Load members</Button></div>}
    <div className="flex flex-wrap items-center gap-3"><label className="flex-1 min-w-48 max-w-sm"><span className="sr-only">Search member email</span><input type="search" className={field} placeholder="Search member email…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>{search && <Button variant="ghost" onClick={() => setSearch("")}>Clear search</Button>}<p className="text-xs text-text-muted">All percentages mean quota remaining.</p></div>
    <section id="seated-members" className={`${panel} scroll-mt-4`} aria-labelledby="seated-title"><h2 id="seated-title" className="text-lg font-semibold">With seats <span className="text-sm font-normal text-text-muted">{seated.length}{search ? ` of ${data.seated.length}` : ""}</span></h2><MemberList members={seated} busy={busy} loaded={Boolean(data.lastCheckedAt)} filtered={Boolean(search)} onCheck={(id) => action({ action: "check", connectionId: id })} /></section>
    <section className={`${panel} space-y-4`} aria-labelledby="manual-title">
      <div><h2 id="manual-title" className="text-lg font-semibold">Manual rotation</h2><p className="mt-1 text-sm text-text-muted">Choose a seat holder and its replacement. Works with automation on or off, using the saved selection rules.</p></div>
      <label className={`${labelClass} max-w-lg`}>Account to rotate out<select className={field} value={manualSource?.id || ""} disabled={busy || Boolean(data.pending)} onChange={(e) => { const m = data.seated.find((row) => row.id === e.target.value); setManualSource(m ? { id: m.id, tier: m.seatTier } : null); setManualTargetId(""); }}><option value="">Select a seat holder</option>{data.seated.map((m) => <option key={m.id} value={m.id} disabled={m.identityVerified === false}>{m.email} · {tier(m.seatTier)}{m.identityVerified === false ? " · Reconnect OAuth" : ""}</option>)}</select></label>
      {manualSource && !source && <p role="alert" className="text-sm text-amber-500">This account no longer holds a seat. Select a seat holder again.</p>}
      {source && <>
        <p className="text-sm">Transfer its <b>{tier(source.seatTier)}</b> seat to one account below. No limit reset will be used and no other seats will be allocated.</p>
        <fieldset disabled={busy || Boolean(data.pending)} className="space-y-2"><legend className="mb-2 font-medium text-sm">Suggested replacements · {suggestions.length} eligible</legend><p className="text-xs text-text-muted pb-2">Ordered by new-member priority, then weighted Fable / weekly / 5h quota and reset time. Unknown quota is verified after assignment; suggestions can change after refreshing.</p>
          {suggestions.map((m, index) => <label key={m.id} className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${manualTargetId === m.id ? "border-brand-500 bg-brand-500/5" : "border-border-subtle"}`}><input className="mt-1" type="radio" name="manual-replacement" value={m.id} checked={manualTargetId === m.id} onChange={() => setManualTargetId(m.id)} /><span className="min-w-0 flex-1"><span className="flex flex-wrap gap-x-2 gap-y-1 text-sm"><b className="break-all">{m.email}</b>{index === 0 && <span className="text-brand-500">Recommended</span>}{!m.hasReceivedSeat && <span className="text-text-muted">New member</span>}</span><span className="block text-xs text-text-muted mt-1">Priority #{index + 1} · Score {m.score.toFixed(1)} · {m.snapshot ? "Estimated quota" : "Quota not measured yet"}</span><span className="grid grid-cols-3 gap-3 mt-3">{[["session", "5h"], ["weekly", "Weekly"], ["fable", "Fable"]].map(([name, text]) => <span key={name} className="min-w-0"><span className="block mb-1 text-xs text-text-muted">{text} left</span><Quota member={m} name={name} waiting /></span>)}</span></span></label>)}
          {!suggestions.length && <p className="text-sm text-text-muted">No eligible replacement. Refresh data or reconnect accounts needing OAuth. The current holder keeps its seat.</p>}
        </fieldset>
        {manualTargetId && !target && <p role="alert" className="text-sm text-amber-500">The selected replacement is no longer eligible. Choose another account.</p>}
        {target && <p className="text-sm break-words"><b>{source.email}</b> → <b>{target.email}</b> · {tier(source.seatTier)}</p>}
        <p className="text-xs text-text-muted">The server rechecks both identities and prepaid capacity, then verifies the replacement quota. If quota is too low, the original seat is restored. Both modes share routing state, history and a transaction lock.</p>
        {dirty && <p className="text-xs text-amber-500">Save your settings before manual rotation.</p>}
        <Button disabled={!canRotate} loading={operation === "rotate"} onClick={() => action({ action: "rotate", sourceId: source.id, targetId: target.id, expectedTier: manualSource.tier })}>Transfer selected seat</Button>
      </>}
    </section>
    <section id="waiting-members" className={`${panel} scroll-mt-4`} aria-labelledby="waiting-title">
      <div className="flex flex-wrap justify-between items-center gap-3"><div><h2 id="waiting-title" className="text-lg font-semibold">Waiting for a seat <span className="text-sm font-normal text-text-muted">{waiting.length}{search || filter !== "all" ? ` of ${data.waiting.length}` : ""}</span></h2><p className="text-xs text-text-muted mt-1">{readyCount} ready to verify · Quota is checked after receiving a seat.</p></div><div className="flex flex-wrap gap-2"><select aria-label="Filter waiting accounts" className={field.replace("w-full", "w-auto")} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All statuses</option><option value="ready">Ready to verify</option><option value="auth">Needs OAuth</option><option value="waiting">Waiting for reset</option></select><select aria-label="Sort waiting accounts" className={field.replace("w-full", "w-auto")} value={sort} onChange={(e) => setSort(e.target.value)}><option value="priority">Next seat priority</option><option value="email">Email A–Z</option></select></div></div>
      <p className="text-xs text-text-muted my-3">Not measured = no saved quota. ~ = estimated from a previous measurement; it may differ after assigning a different seat type.</p>
      <MemberList members={waiting} waiting busy={busy} loaded={Boolean(data.lastCheckedAt)} filtered={Boolean(search) || filter !== "all"} />
    </section>
    {!!data.excluded.length && <details className={panel}><summary className="cursor-pointer text-sm font-medium">Outside this rotation ({data.excluded.length})</summary><div className="pt-3 space-y-2">{data.excluded.map((m) => <p key={m.id} className="text-sm break-all">{m.name}<span className="text-text-muted"> · {m.reason}</span></p>)}</div></details>}
    <details className={panel}><summary className="cursor-pointer text-sm font-medium">Seat & reset history ({data.history.length})</summary><div className="max-h-96 overflow-auto space-y-3 pt-4">{data.history.map((event) => <div key={event.id} className="border-b border-border-subtle pb-2 text-sm"><time className="text-text-muted">{date(event.at)}</time> · <b>{event.type}</b>{event.mode ? ` · ${event.mode}` : ""} · {event.account || [event.from || "Empty seat", event.to].filter(Boolean).join(" → ")}{event.tier ? ` · ${tier(event.tier)}` : ""}{event.error ? ` · ${event.error}` : ""}</div>)}{!data.history.length && <p className="text-sm text-text-muted">No seat changes or limit resets have run yet.</p>}</div></details>
  </div>;
}
