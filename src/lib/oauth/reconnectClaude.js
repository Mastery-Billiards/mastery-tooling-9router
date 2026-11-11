import "open-sse/index.js";
import { randomUUID } from "node:crypto";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { CLAUDE_CLI_VERSION } from "open-sse/providers/shared.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { teamStore, acquireTeamLock } from "@/lib/claudeTeam/store";

// Never deduplicate a reconnect by editable display name or create a new row.
export async function reconnectClaude(connectionId, exchange) {
  const unlock = await acquireTeamLock();
  if (!unlock) throw new Error("Claude Team worker is busy. Wait for it to finish, then retry");
  try {
    const current = await getProviderConnectionById(connectionId);
    if (!current || current.provider !== "claude" || current.authType !== "oauth") throw new Error("Claude OAuth connection not found");
    const state = await teamStore.get("state", { members: {}, history: [] });
    if ([state.pending?.sourceId, state.pending?.targetId].includes(connectionId)) throw new Error("Recover the pending seat operation before reconnecting this account");
    const config = await teamStore.get("config", {});
    const cached = state.members?.[connectionId];
    const proxy = await resolveConnectionProxyConfig(current.providerSpecificData);
    async function profile(accessToken) {
      const response = await proxyAwareFetch("https://api.anthropic.com/api/oauth/profile", {
        headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01", "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)` },
        redirect: "error", signal: AbortSignal.timeout(25000),
      }, proxy);
      if (!response.ok) throw new Error("Unable to verify Claude account identity");
      const value = await response.json();
      if (!value.account?.uuid) throw new Error("Claude profile did not include an account identity");
      return value;
    }
    let expectedId = current.providerSpecificData?.claudeAccountId || cached?.memberId;
    if (!expectedId && !current.email) {
      try { expectedId = (await profile(current.accessToken)).account.uuid; }
      catch { throw new Error("No verified identity is saved for this connection. Refresh Claude Team membership first; its editable name cannot verify identity"); }
    }
    const tokens = await exchange();
    if (!tokens.accessToken || !tokens.refreshToken) throw new Error("Claude did not return a complete OAuth token pair");
    const verified = await profile(tokens.accessToken);
    const email = verified.account.email || verified.account.email_address;
    const same = expectedId ? expectedId === verified.account.uuid : email && current.email.trim().toLowerCase() === email.trim().toLowerCase();
    if (!same) throw new Error(`Wrong Claude account. Sign in to ${current.email || cached?.email || current.name}. The existing connection was not changed`);
    if (cached && config.orgId && verified.organization?.uuid !== config.orgId) throw new Error("Choose the same Claude Team organization when authorizing this account");
    const now = new Date().toISOString();
    const updated = await updateProviderConnection(connectionId, {
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      expiresAt: Number(tokens.expiresIn) > 0 ? new Date(Date.now() + Number(tokens.expiresIn) * 1000).toISOString() : null,
      ...(tokens.scope ? { scope: tokens.scope } : {}), ...(email ? { email } : {}),
      providerSpecificData: { ...current.providerSpecificData, claudeAccountId: verified.account.uuid },
      lastRefreshAt: now, testStatus: "active", lastTested: now,
      // isActive, name, proxy, priority and all usage/seat history stay intact.
    });
    if (!updated) throw new Error("Connection was deleted during reconnect");
    if (cached) {
      cached.identityVerified = true; cached.verifiedAt = now; cached.error = null;
      state.history = [{ id: randomUUID(), at: now, type: "oauth-reconnected", account: email || cached.email }, ...(state.history || [])].slice(0, 1000);
      await teamStore.set("state", state);
    }
    return updated;
  } finally { unlock(); }
}
