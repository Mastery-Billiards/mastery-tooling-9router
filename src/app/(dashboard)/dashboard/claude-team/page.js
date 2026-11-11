"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import { needsInitialInspection } from "@/lib/claudeTeam/policy";
import { memberStatus, quotaDisplay, remainingResets, selectMembers, seatSummary, recommendationReasons, automationStatus, activityLabel, allPlanMembers } from "@/lib/claudeTeam/presentation";

const field = "rounded-lg border border-border-subtle bg-bg px-3 py-2 text-sm w-full min-w-0";
const panel = "rounded-xl border border-border-subtle bg-surface p-4 sm:p-5";
const labelClass = "flex min-w-0 flex-col justify-end gap-2 text-sm";
const providerUrl = "/dashboard/providers/claude";
const toneClass = { danger: "bg-red-500/10 text-red-500", warning: "bg-amber-500/10 text-amber-500", success: "bg-emerald-500/10 text-emerald-500", neutral: "bg-surface-2 text-text-muted" };
const date = (value, full = false) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleString(undefined, full ? {} : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
const tier = (value) => value === "all" ? "All plans" : value === "team_tier_1" ? "Premium" : "Standard";

function WhyCandidate({ member, config }) {
  return <details className="text-xs text-text-muted mt-2"><summary className="cursor-pointer text-brand-500">Why this priority?</summary><ul className="list-disc pl-4 mt-2 space-y-1 max-w-lg">{recommendationReasons(member, config).map((reason) => <li key={reason}>{reason}</li>)}</ul></details>;
}

function Activity({ event }) {
  const quotaText = (quota) => ["session", "weekly", "fable"].filter((key) => quota?.[key]).map((key) => `${key === "session" ? "5h" : key === "fable" ? "Fable" : "Weekly"} ${quota[key].remaining}%`).join(" · ");
  return <div className="text-sm space-y-1 break-words"><div className="flex flex-wrap gap-2 items-center"><b>{activityLabel(event.type)}</b><span className="text-xs text-text-muted">{date(event.at)}{event.mode ? ` · ${event.mode}` : ""}{event.recovered ? " · recovered" : ""}</span></div><p>{event.account || (event.from || event.to || event.type === "seat-transferred" || event.type === "seat-rollback" ? `${event.from || "Free prepaid seat"} → ${event.to || "Free prepaid seat"}` : "Claude Team check")}{event.tier ? ` · ${tier(event.tier)}` : ""}</p>{event.reason && <p className="text-xs text-text-muted">{event.reason}</p>}{quotaText(event.quotaBefore) && <p className="text-xs text-text-muted">Before (% left): {quotaText(event.quotaBefore)}</p>}{quotaText(event.quotaAfter) && <p className="text-xs text-text-muted">After (% left): {quotaText(event.quotaAfter)}</p>}{event.error && <p className="text-xs text-red-500">{event.error}</p>}</div>;
}

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
  return <div className="min-w-0 space-y-1.5" title={`${q.source === "historical" ? "Last recorded measurement; see its plan and timestamp on the account" : q.source === "estimated" ? "Estimate from the last measurement" : "Measured quota"}. Reset: ${date(q.resetAt, true)}`}>
    <div className={`text-sm font-medium tabular-nums ${colors.text}`}>{q.source === "estimated" ? "~" : ""}{Math.round(q.remaining * 10) / 10}%<span className="ml-1 text-xs font-normal text-text-muted">left</span></div>
    <div className={`h-1.5 rounded ${colors.track}`} role="meter" aria-label={`${name === "session" ? "5h" : name} quota remaining for ${member.email}`} aria-valuenow={q.remaining} aria-valuemin={0} aria-valuemax={100}><div className={`h-full rounded ${colors.bar}`} style={{ width: `${Math.min(q.remaining, 100)}%` }} /></div>
    <div className="text-[11px] text-text-muted">Reset {date(q.resetAt)}</div>
  </div>;
}

function MemberIdentity({ member, waiting, config }) {
  const status = memberStatus(member, waiting);
  return <div className="min-w-0 space-y-1.5">
    <div className="break-all font-medium">{member.email}</div>
    <div className="flex flex-wrap items-center gap-2"><Badge status={status} />{!waiting && <span className="text-xs text-text-muted">{tier(member.seatTier)}</span>}{waiting && !member.hasReceivedSeat && member.identityVerified !== false && <span className="text-xs text-brand-500">New member</span>}</div>
    {waiting && config && <WhyCandidate member={member} config={config} />}
    {member.error && <div className="max-w-80 text-xs text-red-500">{member.identityVerified === false ? "OAuth could not be verified. Reconnect this account before rotation." : member.error}</div>}
    {member.identityVerified === false ? <Link href={providerUrl} className="inline-block text-xs text-brand-500 underline underline-offset-2">Open Claude accounts →</Link> : <p className="text-[11px] text-text-muted">{member.snapshot ? `${waiting ? "Last measured" : "Measured"} ${date(member.snapshot.measuredAt)}${waiting && member.snapshot.tier ? ` · ${tier(member.snapshot.tier)}` : member.allPlans ? " · Plan not recorded" : ""}` : "Quota is checked after receiving a seat"}</p>}
  </div>;
}

function Priority({ member }) {
  if (member.allPlans) return <div className="space-y-2 text-xs">{member.plans.map((plan) => <div key={plan.targetTier}><b>{tier(plan.targetTier)}</b><p className="text-text-muted">{plan.identityVerified === false ? "Needs OAuth" : !plan.ready ? "Waiting for reset" : plan.quotaConfidence === "unknown" ? "Needs verification" : `Priority #${plan.rank} · Score ${plan.score.toFixed(1)}`}</p></div>)}</div>;
  return member.ready ? <div className="whitespace-nowrap"><b className="text-lg">#{member.rank}</b><div className="text-xs text-text-muted" title="Weighted estimate used to select the next account; not a measured quota percentage.">{Number.isFinite(member.score) ? `Score ${member.score.toFixed(1)}` : "Quota unknown"}</div></div> : <span className="text-text-muted" title="Not eligible for the next seat allocation">—</span>;
}

function MemberList({ members, waiting = false, onCheck, busy, loaded, filtered, config }) {
  if (!members.length) return <p className="py-5 text-sm text-text-muted">{filtered ? "No accounts match these filters." : loaded ? waiting ? "No managed accounts are waiting for a seat." : "No managed accounts currently have a seat." : "Members appear here after admin setup and the first refresh."}</p>;
  return <>
    <div className="hidden overflow-x-auto xl:block"><table className="w-full text-left text-sm">
      <caption className="sr-only">{waiting && members[0]?.allPlans ? "Waiting accounts with separate eligibility by plan. Quota values are last recorded measurements." : `${waiting ? "Accounts waiting for a seat, ordered by allocation priority" : "Managed accounts with assigned seats"}. All percentages show quota remaining.`}</caption>
      <thead className="text-text-muted"><tr>{[...(waiting ? [members[0]?.allPlans ? "Eligibility by plan" : "Next"] : []), "Account", ...(members[0]?.allPlans ? ["5h recorded", "Weekly recorded", "Fable recorded", "Recorded resets"] : ["5h left", "Weekly left", "Fable left", "Resets left"]), ...(!waiting ? ["Action"] : [])].map((text) => <th key={text} scope="col" className="px-3 py-3 font-medium whitespace-nowrap">{text}</th>)}</tr></thead>
      <tbody>{members.map((m) => <tr key={m.id} className="border-t border-border-subtle align-top hover:bg-surface-2/50 transition-colors">
        {waiting && <td className="px-3 py-4"><Priority member={m} /></td>}
        <td className="px-3 py-4"><MemberIdentity member={m} waiting={waiting} config={config} /></td>
        {["session", "weekly", "fable"].map((name) => <td className="px-3 py-4 min-w-28" key={name}><Quota member={m} name={name} waiting={waiting} /></td>)}
        <td className="px-3 py-4 text-text-muted">{remainingResets(waiting && m.targetTier ? m.quotaSnapshot : m.snapshot) ?? "Not measured"}</td>
        {!waiting && <td className="px-3 py-4"><Button variant="secondary" size="sm" disabled={busy} onClick={() => onCheck(m.id)} aria-label={`Refresh quota for ${m.email}`}>Refresh</Button></td>}
      </tr>)}</tbody>
    </table></div>
    <div className="divide-y divide-border-subtle xl:hidden">{members.map((m) => <article key={m.id} className="py-4 space-y-4">
      <div className="flex gap-3 items-start">{waiting && <Priority member={m} />}<MemberIdentity member={m} waiting={waiting} config={config} /></div>
      <div className="grid grid-cols-3 gap-3">{[["session", "5h"], ["weekly", "Weekly"], ["fable", "Fable"]].map(([name, text]) => <div key={name} className="min-w-0"><div className="mb-2 text-xs text-text-muted">{text} {m.allPlans ? "recorded" : "left"}</div><Quota member={m} name={name} waiting={waiting} /></div>)}</div>
      <div className="flex items-center justify-between gap-2 text-xs text-text-muted"><span>Resets left: {remainingResets(waiting && m.targetTier ? m.quotaSnapshot : m.snapshot) ?? "Not measured"}</span>{!waiting && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onCheck(m.id)} aria-label={`Refresh quota for ${m.email}`}>Refresh quota</Button>}</div>
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
  const [search, setSearch] = useState(""), [filter, setFilter] = useState("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [surveyOpen, setSurveyOpen] = useState(false), [surveySource, setSurveySource] = useState(null);
  const [allocationTier, setAllocationTier] = useState("all");
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
          if (!result.error && result.admin) setSettingsOpen(false);
          setNotice(result.error ? "Settings saved, but refreshing members failed. See the error above." : result.lastCheckedAt ? "Settings saved and members refreshed." : "Settings saved. Select an organization to finish setup.");
        } else if (body.action === "check") setNotice("Member data and quota refreshed. No seats or reset credits were changed.");
        else if (body.action === "rotate") {
          setManualSource(null); setManualTargetId("");
          setNotice("Seat transferred and replacement quota verified. Routing, history and the next automatic check are updated.");
        } else if (body.action === "measure-waiting") {
          setSurveyOpen(false); setSurveySource(null);
          setAllocationTier(result.survey.tier);
          setNotice(`Seat returned. ${result.survey.completed - result.survey.failed} accounts measured, ${result.survey.failed} failed, ${result.survey.skipped} skipped (OAuth). Waiting priority is updated for ${tier(result.survey.tier)}.`);
        } else if (body.action === "recover") setNotice("Pending transaction reconciled. Review the current seats before starting another rotation.");
      }
    } catch (e) { setError(e.message); await load().catch(() => {}); }
    finally { setOperation(""); }
  }
  if (!config) return <div className="p-6" role="status">{error || "Loading Claude Team…"}</div>;
  const busy = Boolean(operation) || data.running;
  const dirty = Boolean(sessionKey.trim()) || JSON.stringify(config) !== JSON.stringify(data.config);
  const patch = (key, value) => setConfig((c) => ({ ...c, [key]: value }));
  const allocationCandidates = allocationTier === "all" ? allPlanMembers(data.candidatesByTier) : data.candidatesByTier?.[allocationTier] || data.waiting;
  const all = [...data.seated, ...allocationCandidates];
  const workerStatus = automationStatus({ ...data, running: busy });
  const authIssues = all.filter((m) => m.identityVerified === false).length;
  const readyCount = allocationCandidates.filter((m) => m.ready).length;
  const source = data.seated.find((m) => m.id === manualSource?.id);
  const suggestions = (data.candidatesByTier?.[source?.seatTier] || data.waiting).filter((m) => m.ready);
  const target = suggestions.find((m) => m.id === manualTargetId);
  const canRotate = source && source.identityVerified !== false && source.seatTier === manualSource.tier && target && !busy && !dirty && !data.pending;
  const lender = data.seated.find((m) => m.id === surveySource?.id);
  const canMeasure = lender && lender.identityVerified !== false && lender.seatTier === surveySource.tier && !busy && !dirty && !data.pending;
  const seated = selectMembers(data.seated, { search, sort: "email" });
  const waiting = selectMembers(allocationCandidates, { search, filter });
  const complete = Boolean(data.config.adminConnectionId && data.config.orgId && data.sessionConfigured);
  const savedOrg = data.config.orgId;
  const orgOptions = orgs.some((o) => o.id === savedOrg) || !savedOrg ? orgs : [{ id: savedOrg, name: data.admin?.orgName || "Saved organization" }, ...orgs];
  return <div className="p-4 sm:p-6 space-y-5 max-w-screen-2xl mx-auto min-w-0">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Claude Team</h1><p className="text-sm text-text-muted mt-1">Seat allocation and quota for your 9router accounts.</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setSettingsOpen(true)}>Settings{dirty ? " · Unsaved" : ""}</Button><Button variant="secondary" loading={busy} onClick={() => action({ action: "check" })}>{operation === "configure" ? "Saving & refreshing…" : busy ? "Loading…" : "Refresh data"}</Button><Button disabled={busy || !data.config.enabled || dirty} title={dirty ? "Save your changes first" : !data.config.enabled ? "Enable automation in Settings first" : "Run the configured seat rotation now"} onClick={() => action({ action: "run" })}>Run auto rules</Button></div>
    </header>
    {connectionError && <div role="alert" className="rounded-lg bg-amber-500/10 p-4 text-sm">{connectionError} Showing the last loaded data. <Link href="/login" className="underline">Sign in</Link></div>}
    {(error || data.error) && <div role="alert" className="rounded-lg bg-red-500/10 text-red-500 p-4 text-sm">{error || data.error}</div>}
    {notice && <div role="status" className={`rounded-lg p-3 text-sm ${data.error ? "bg-amber-500/10" : "bg-emerald-500/10"}`}>{notice}</div>}
    <div className={`${panel} flex flex-wrap items-start justify-between gap-3`}>
      <div className="space-y-1"><Badge status={{ tone: data.config.enabled ? "success" : "neutral", label: data.config.enabled ? "Automation on" : "Automation off" }} /><p className="text-sm text-text-muted">{data.config.enabled ? `Checks every ${data.config.intervalMinutes} min · Next run ${date(data.nextRunAt)}` : "Automatic changes are paused. Refresh data or transfer a selected seat manually."}</p></div>
      <div className="space-y-1 text-xs text-text-muted"><Badge status={workerStatus} /><p>{workerStatus.detail}</p><p>Last successful automatic check {date(data.lastAutoSuccessAt)}</p>{data.error && !data.pending && <Button variant="secondary" size="sm" disabled={busy} onClick={() => action({ action: data.config.enabled ? "run" : "check" })}>Retry check</Button>}</div>
      <div className="text-xs text-text-muted">Last refreshed <span title={date(data.lastCheckedAt, true)}>{date(data.lastCheckedAt)}</span></div>
    </div>
    {!!data.history.length && <section className={panel} aria-label="Latest activity"><h2 className="text-sm font-semibold mb-2">Latest activity</h2><Activity event={data.history[0]} /></section>}
    <div className="grid sm:grid-cols-3 gap-3">
      {["team_standard", "team_tier_1"].map((key) => { const s = seatSummary(data, key); return <section className={panel} key={key}><h2 className="text-sm font-medium text-text-muted">{tier(key)} · entire organization</h2><p className="mt-2 text-2xl font-semibold tabular-nums">{s.known ? `${s.used} / ${s.purchased}` : "Not loaded"}<span className="text-xs font-normal text-text-muted ml-2">{s.known ? "seats used" : ""}</span></p>{s.known && <p className="mt-2 text-xs text-text-muted"><span className={s.free ? "text-emerald-500 font-medium" : ""}>{s.free} free prepaid</span>{s.reserved ? ` · ${s.reserved} reserved` : ""}{s.external ? ` · ${s.external} used outside 9router` : ""}</p>}</section>; })}
      <section className={panel}><h2 className="text-sm font-medium text-text-muted">Managed accounts</h2><p className="mt-2 text-2xl font-semibold">{data.lastCheckedAt ? all.length : "Not loaded"}</p><p className="mt-2 text-xs text-text-muted">{data.counts ? `${data.counts.total} members in org · ${readyCount} ready for verification (${tier(allocationTier)})${authIssues ? ` · ${authIssues} need OAuth` : ""}` : "Finish admin setup to load members"}</p></section>
    </div>
    {authIssues > 0 && <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-4 text-sm flex flex-wrap justify-between items-center gap-2"><p><b>{authIssues} accounts need OAuth verification.</b> They remain visible but cannot receive a seat.</p><a href={data.seated.some((m) => m.identityVerified === false) ? "#seated-members" : "#waiting-members"} className="font-medium text-brand-500 underline" onClick={() => { setFilter("auth"); setSearch(""); }}>Review accounts →</a></div>}
    {data.pending && <div className="rounded-lg bg-amber-500/10 p-4 text-sm space-y-2"><p>An incomplete {data.pending.type} operation is saved. Recover it before starting another rotation. Automatic runs also reconcile it before new work.</p><Button variant="secondary" disabled={busy} onClick={() => action({ action: "recover" })}>Recover pending operation</Button></div>}

    {!complete && <p className="text-sm text-text-muted">Open Settings to configure the admin, web session and organization.</p>}
    <Modal isOpen={surveyOpen} onClose={() => { if (!busy) setSurveyOpen(false); }} closeOnOverlay={!busy} title="Measure waiting accounts" size="md">
      <div className="space-y-4" role="dialog" aria-modal="true" aria-label="Measure waiting accounts">
        <p className="text-sm text-text-muted">Temporarily borrow one seat to measure every waiting account in this organization, including accounts hidden by filters. The seat is returned after each measurement. Accounts needing OAuth are skipped.</p>
        <label className={labelClass}>Borrow seat from<select className={field} value={surveySource?.id || ""} disabled={busy} onChange={(e) => { const m = data.seated.find((row) => row.id === e.target.value); setSurveySource(m ? { id: m.id, tier: m.seatTier } : null); }}><option value="">Select a seat holder</option>{data.seated.filter((m) => m.identityVerified !== false).map((m) => <option key={m.id} value={m.id}>{m.email} · {tier(m.seatTier)}</option>)}</select></label>
        <p className="text-sm text-text-muted">{lender ? `Measures ${tier(lender.seatTier)} quota only. ` : ""}The lender is temporarily removed from routing while its seat is borrowed. Waiting accounts stay out of routing. Automatic rotation waits until the scan finishes; reset credits are not used.</p>
        {(error || data.error) && <p role="alert" className="text-sm text-red-500">{error || data.error}</p>}
        {data.survey?.status === "running" && <p role="status" className="text-sm">{data.survey.completed} / {data.survey.total} checked · {data.worker?.account || "Returning seat…"}</p>}
        <div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setSurveyOpen(false)}>Cancel</Button><Button disabled={!canMeasure} loading={operation === "measure-waiting"} onClick={() => action({ action: "measure-waiting", sourceId: lender.id, expectedTier: surveySource.tier })}>Measure all waiting accounts</Button></div>
      </div>
    </Modal>
    <Modal isOpen={settingsOpen} onClose={() => { if (!busy) setSettingsOpen(false); }} closeOnOverlay={!busy} title="Claude Team settings" size="full">
      <div role="dialog" aria-modal="true" aria-label="Claude Team settings">
      <p className="text-xs text-text-muted">{data.admin ? `${data.admin.email} · ${data.admin.orgName} · verified` : "Configure the admin, web session and organization"}</p>
      {(error || data.error) && <p role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-500">{error || data.error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-text-muted">{notice}</p>}
      <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); action({ action: "configure", config, ...(sessionKey ? { sessionKey } : {}) }); }}>
        <div className="grid lg:grid-cols-3 gap-4">
          <label className={labelClass}>Admin account<select className={field} value={config.adminConnectionId} onChange={(e) => patch("adminConnectionId", e.target.value)}><option value="">Select account</option>{data.accounts.map((a) => <option key={a.id} value={a.id}>{a.email || a.name}</option>)}</select></label>
          <label className={labelClass}>Admin web sessionKey<input type="password" autoComplete="off" className={field} value={sessionKey} onChange={(e) => setSessionKey(e.target.value)} placeholder={data.sessionConfigured ? "Saved · enter only to replace" : "Paste sessionKey"} /></label>
          <label className={labelClass}>Team organization{orgOptions.length ? <select className={field} value={config.orgId} onChange={(e) => patch("orgId", e.target.value)}><option value="">Select organization</option>{orgOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select> : <input className={field} value={config.orgId} onChange={(e) => patch("orgId", e.target.value)} placeholder="Discover after saving the session" />}</label>
        </div>
        <div className="grid sm:grid-cols-3 gap-4">{[["threshold", "Rotate at % remaining", 1, 30], ["resetThreshold", "Use reset at % remaining", 0, 5], ["intervalMinutes", "Check interval (minutes)", 1, 60]].map(([key, label, min, max]) => <label key={key} className={labelClass}>{label}<input type="number" min={min} max={max} className={field} value={config[key]} onChange={(e) => patch(key, Number(e.target.value))} /></label>)}</div>
        <label className="flex items-start gap-2 text-sm"><input className="mt-0.5" type="checkbox" checked={config.enabled} onChange={(e) => patch("enabled", e.target.checked)} /><span>Enable automatic seat rotation and limit resets<span className="block text-xs text-text-muted mt-1">Takes effect only after saving. Uses prepaid seats only.</span></span></label>
        <details className="rounded-lg border border-border-subtle p-3"><summary className="cursor-pointer text-sm">Advanced selection & reset rules</summary><div className="pt-4 space-y-4"><div className="grid sm:grid-cols-3 gap-4">{["fable", "weekly", "session"].map((key) => <label key={key} className={labelClass}>{key === "session" ? "5h" : key === "fable" ? "Fable" : "Weekly"} priority weight (%)<input type="number" min="0" max="100" step="1" className={field} value={Math.round(config.weights[key] * 100)} onChange={(e) => patch("weights", { ...config.weights, [key]: Number(e.target.value) / 100 })} /></label>)}</div><p className="text-xs text-text-muted">Weights are normalized automatically. New members take priority on the next allocation, without displacing a healthy seat holder.</p><label className="flex items-start gap-2 text-sm"><input className="mt-0.5" type="checkbox" checked={config.expiringReset} onChange={(e) => patch("expiringReset", e.target.checked)} /><span>Use a reset expiring within 24 hours when weekly or Fable has less than 20% left.</span></label></div></details>
        <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={busy} loading={operation === "configure"}>Save & refresh members</Button><Button type="button" variant="secondary" disabled={busy || !data.sessionConfigured} onClick={() => action({ action: "discover" })}>Discover organizations</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setSettingsOpen(false)}>Close</Button>{dirty && <span className="text-xs text-amber-500" role="status">Unsaved changes</span>}</div>
        <p className="text-xs text-text-muted">First setup: save the admin and session, discover and select the organization, then save again. Refreshing data does not enable automation.</p>
      </form>
      </div>
    </Modal>

    {!data.lastCheckedAt && complete && <div role="status" className="rounded-lg bg-amber-500/10 p-4 text-sm">{busy ? "Verifying admin and loading members…" : "Members have not loaded yet."}<Button variant="secondary" className="ml-3" disabled={busy} onClick={() => action({ action: "check" })}>Load members</Button></div>}
    <div className="flex flex-wrap items-center gap-3"><label className="flex-1 min-w-48 max-w-sm"><span className="sr-only">Search member email</span><input type="search" className={field} placeholder="Search member email…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>{search && <Button variant="ghost" onClick={() => setSearch("")}>Clear search</Button>}<p className="text-xs text-text-muted">All percentages mean quota remaining.</p></div>
    <section id="seated-members" className={`${panel} scroll-mt-4`} aria-labelledby="seated-title"><h2 id="seated-title" className="text-lg font-semibold">With seats <span className="text-sm font-normal text-text-muted">{seated.length}{search ? ` of ${data.seated.length}` : ""}</span></h2><MemberList config={data.config} members={seated} busy={busy} loaded={Boolean(data.lastCheckedAt)} filtered={Boolean(search)} onCheck={(id) => action({ action: "check", connectionId: id })} /></section>
    <section className={`${panel} space-y-4`} aria-labelledby="manual-title">
      <div><h2 id="manual-title" className="text-lg font-semibold">Manual rotation</h2><p className="mt-1 text-sm text-text-muted">Choose a seat holder and its replacement. Works with automation on or off, using the saved selection rules.</p></div>
      <label className={`${labelClass} max-w-lg`}>Account to rotate out<select className={field} value={manualSource?.id || ""} disabled={busy || Boolean(data.pending)} onChange={(e) => { const m = data.seated.find((row) => row.id === e.target.value); setManualSource(m ? { id: m.id, tier: m.seatTier } : null); setManualTargetId(""); }}><option value="">Select a seat holder</option>{data.seated.map((m) => <option key={m.id} value={m.id} disabled={m.identityVerified === false}>{m.email} · {tier(m.seatTier)}{m.identityVerified === false ? " · Reconnect OAuth" : ""}</option>)}</select></label>
      {manualSource && !source && <p role="alert" className="text-sm text-amber-500">This account no longer holds a seat. Select a seat holder again.</p>}
      {source && <>
        <p className="text-sm">Transfer its <b>{tier(source.seatTier)}</b> seat to one account below. No limit reset will be used and no other seats will be allocated.</p>
        <fieldset disabled={busy || Boolean(data.pending)} className="space-y-2"><legend className="mb-2 font-medium text-sm">Suggested replacements · {suggestions.length} eligible</legend><p className="text-xs text-text-muted pb-2">Ranked for the selected seat tier: known usable quota first, then accounts needing verification. New-member priority and weighted Fable / weekly / 5h quota apply within each group. Unknown quota is verified after assignment; suggestions can change after refreshing.</p>
          {suggestions.map((m, index) => <label key={m.id} className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${manualTargetId === m.id ? "border-brand-500 bg-brand-500/5" : "border-border-subtle"}`}><input className="mt-1" type="radio" name="manual-replacement" value={m.id} checked={manualTargetId === m.id} onChange={() => setManualTargetId(m.id)} /><span className="min-w-0 flex-1"><span className="flex flex-wrap gap-x-2 gap-y-1 text-sm"><b className="break-all">{m.email}</b>{index === 0 && <span className="text-brand-500">Recommended</span>}{!m.hasReceivedSeat && <span className="text-text-muted">New member</span>}</span><span className="block text-xs text-text-muted mt-1">Priority #{index + 1} · {Number.isFinite(m.score) ? `Score ${m.score.toFixed(1)} · Estimated ${tier(source.seatTier)} quota` : `${tier(source.seatTier)} quota unknown · Verify after assignment`}</span><span className="block mt-1 text-xs text-text-muted">{recommendationReasons(m, data.config)[0]}</span><span className="grid grid-cols-3 gap-3 mt-3">{[["session", "5h"], ["weekly", "Weekly"], ["fable", "Fable"]].map(([name, text]) => <span key={name} className="min-w-0"><span className="block mb-1 text-xs text-text-muted">{text} left</span><Quota member={m} name={name} waiting /></span>)}</span></span></label>)}
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
      <div className="flex flex-wrap justify-between items-center gap-3"><div><h2 id="waiting-title" className="text-lg font-semibold">Waiting for a seat <span className="text-sm font-normal text-text-muted">{waiting.length}{search || filter !== "all" ? ` of ${data.waiting.length}` : ""}</span></h2><p className="text-xs text-text-muted mt-1">{readyCount} accounts eligible for verification · {tier(allocationTier)} · Quota is checked after receiving a seat.</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy || dirty || !complete || Boolean(data.pending) || !data.waiting.length} onClick={() => { setError(""); setSurveyOpen(true); }}>Measure waiting quota</Button><select aria-label="Seat tier for waiting accounts" className={field.replace("w-full", "w-auto")} value={allocationTier} onChange={(e) => setAllocationTier(e.target.value)}><option value="all">All plans</option><option value="team_standard">Standard seat</option><option value="team_tier_1">Premium seat</option></select><select aria-label="Filter waiting accounts" className={field.replace("w-full", "w-auto")} value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All statuses</option><option value="ready">Ready to verify</option><option value="auth">Needs OAuth</option><option value="waiting">Waiting for reset</option></select></div></div>
      <p className="text-xs text-text-muted my-3">{allocationTier === "all" ? "Ordered by next-seat priority: known usable quota first, then accounts needing verification, then accounts waiting for reset. Within each group, the best priority rank across eligible plans comes first. The next seat’s plan determines the actual selection. Quota columns show the last recorded measurement and its plan; balances from different plans are never combined." : "Candidates and quota below apply to the selected tier. ~ = estimate from that tier. Another tier’s measurement or a stale balance is not presented as current quota."}</p>
      {data.survey && <p role="status" className="text-xs text-text-muted mb-3">Last quota scan · {tier(data.survey.tier)} · {data.survey.status} · {data.survey.completed} / {data.survey.total} checked · {data.survey.failed} failed · {data.survey.skipped} skipped{data.survey.completedAt ? ` · ${date(data.survey.completedAt)}` : ""}</p>}
      <MemberList config={data.config} members={waiting} waiting busy={busy} loaded={Boolean(data.lastCheckedAt)} filtered={Boolean(search) || filter !== "all"} />
    </section>
    <details className={panel}><summary className="cursor-pointer text-sm font-medium">Seat & reset history ({data.history.length})</summary><div className="max-h-96 overflow-auto space-y-3 pt-4">{data.history.map((event) => <div key={event.id} className="border-b border-border-subtle pb-3"><Activity event={event} /></div>)}{!data.history.length && <p className="text-sm text-text-muted">No seat changes or limit resets have run yet.</p>}</div></details>
  </div>;
}
