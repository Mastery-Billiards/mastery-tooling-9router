"use client";
import { useCallback, useEffect, useState } from "react";
import Button from "./Button";
import Modal from "./Modal";

export default function ForkUpdatePanel({ onClose, onVersionChange }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [versions, setVersions] = useState(null);
  const [checking, setChecking] = useState(true);
  const [versionError, setVersionError] = useState("");
  const checkVersions = useCallback(async () => {
    setChecking(true); setVersionError("");
    try {
      const response = await fetch("/api/version/fork?refresh=1", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not check Git versions");
      const data = await response.json(); setVersions(data); onVersionChange?.(data);
    } catch (e) { setVersions(null); setVersionError(e.message); onVersionChange?.({ available: true, error: e.message }); }
    finally { setChecking(false); }
  }, [onVersionChange]);
  useEffect(() => { const timer = setTimeout(checkVersions, 0); return () => clearTimeout(timer); }, [checkVersions]);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch("/api/version/update", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not read update status");
        if (!cancelled) { setState(data); setRestarting(false); }
      } catch { if (!cancelled) setRestarting(true); }
    }
    poll(); const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  useEffect(() => { if (state?.phase !== "done") return; const timer = setTimeout(checkVersions, 0); return () => clearTimeout(timer); }, [state?.phase, state?.sha, checkVersions]);
  async function start() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/version/update", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start update");
      setState(data);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const remoteLine = (remote) => remote && <div className="rounded-lg border border-border-subtle p-3 space-y-1" key={remote.label}><b className="text-sm">{remote.label}</b><p className={`text-sm ${remote.status === "behind" ? "text-amber-500" : remote.status === "up-to-date" ? "text-emerald-500" : "text-text-muted"}`}>{remote.status === "behind" ? `${remote.behind} new commits to sync${remote.ahead ? ` · fork has ${remote.ahead} additional commits` : ""}` : remote.status === "up-to-date" ? `Up to date${remote.ahead ? ` · fork has ${remote.ahead} additional commits` : ""}` : remote.message}</p>{remote.sha && <p className="text-xs font-mono text-text-muted">{remote.version ? `v${remote.version} · ` : ""}{remote.sha.slice(0, 12)}</p>}</div>;
  return <Modal isOpen onClose={onClose} title="Sync custom fork" size="xl">
    <div className="space-y-4">
      <p className="text-sm text-text-muted">Sync origin/master and upstream 9router, build and verify a separate release, then restart the HTTP server. The tray stays running.</p>
      <div className="rounded-lg bg-bg-primary p-3 text-sm"><b>Running fork</b><p className="font-mono">{versions?.currentSha ? `${versions.currentVersion ? `v${versions.currentVersion} · ` : ""}${versions.currentSha.slice(0, 12)}` : checking ? "Checking…" : "Unavailable"}</p>{versions?.localChangesNotDeployed && <p className="text-xs text-amber-500 mt-1">The checkout contains commits that are not in the running release.</p>}</div>
      {checking && <p role="status" className="text-sm text-text-muted">Checking latest Git commits…</p>}
      {versions?.available === false && <p className="text-sm text-amber-500">Git comparison is available only when running a managed custom fork.</p>}
      {versions?.error && <p role="alert" className="text-sm text-amber-500">{versions.error}</p>}
      {!checking && <div className="grid gap-2 sm:grid-cols-2">{remoteLine(versions?.origin)}{remoteLine(versions?.upstream)}</div>}
      {versions?.checkedAt && <p className="text-xs text-text-muted">Last checked: {new Date(versions.checkedAt).toLocaleString()}</p>}
      {versionError && <p role="alert" className="text-sm text-red-500">{versionError}</p>}
      <p role="status" className="font-medium">{restarting ? "Waiting for server connection…" : state?.running ? `Updating: ${state.phase}` : state?.phase === "done" ? "Last deployment completed" : state?.phase || "Loading…"}</p>
      {state?.message && <p className="text-sm">{state.message}</p>}
      {state?.conflicts?.length > 0 && <ul className="text-sm text-red-500 list-disc pl-5">{state.conflicts.map((file) => <li key={file}>{file}</li>)}</ul>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <div className="flex flex-wrap gap-2 justify-end"><Button variant="secondary" disabled={checking || state?.running} onClick={checkVersions}>Check again</Button><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={!state?.available || state.running || busy || restarting || checking} onClick={start}>{state?.running ? "Updating…" : "Sync & update"}</Button></div>
      <p className="text-xs text-text-muted">Details: ~/.9router/logs/sync-upstream.log. Commit local changes before updating.</p>
    </div>
  </Modal>;
}
