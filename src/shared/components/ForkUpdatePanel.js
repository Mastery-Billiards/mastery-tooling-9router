"use client";
import { useEffect, useState } from "react";
import Button from "./Button";

export default function ForkUpdatePanel({ onClose }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
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
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6">
    <div className="max-w-lg w-full rounded-xl bg-bg-primary border border-border-subtle p-6 space-y-4">
      <h2 className="text-xl font-semibold">Update custom fork</h2>
      <p className="text-sm text-text-muted">Merge upstream, build and check a separate release, then restart the HTTP server. The tray stays running.</p>
      <p role="status" className="font-medium">{restarting ? "Waiting for server connection…" : state?.phase || "Loading…"}</p>
      {state?.message && <p className="text-sm">{state.message}</p>}
      {state?.conflicts?.length > 0 && <ul className="text-sm text-red-500 list-disc pl-5">{state.conflicts.map((file) => <li key={file}>{file}</li>)}</ul>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {state?.sha && <p className="font-mono text-xs text-text-muted">{state.sha.slice(0, 12)}</p>}
      <div className="flex gap-2 justify-end"><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={!state?.available || state.running || busy || restarting} onClick={start}>{state?.running ? "Updating…" : "Sync & update"}</Button></div>
      <p className="text-xs text-text-muted">Details: ~/.9router/logs/sync-upstream.log. Commit local changes before updating.</p>
    </div>
  </div>;
}
