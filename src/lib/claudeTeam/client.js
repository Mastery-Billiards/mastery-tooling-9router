import "open-sse/index.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route";
import { CLAUDE_CLI_VERSION } from "open-sse/providers/shared.js";

export function createTeamClient(sessionKey, adminProxy = null, fetcher = proxyAwareFetch) {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
  const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);
  function networkFailure(error) {
    const code = error?.cause?.code || error?.code;
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    return { retryable: timeout || networkCodes.has(code), detail: timeout ? "timeout" : networkCodes.has(code) ? `network error (${code})` : "connection failed" };
  }
  async function json(url, options = {}, proxy = adminProxy) {
    const parsed = new URL(url);
    const admin = parsed.hostname === "claude.ai";
    const endpoint = parsed.pathname.split("/").filter(Boolean).at(-1);
    const label = `Claude ${admin ? "admin" : "OAuth"} ${endpoint}`;
    const read = ["GET", "HEAD"].includes((options.method || "GET").toUpperCase());
    const failure = (error) => new Error(`${label}: ${networkFailure(error).detail}. ${read ? "Read request failed; check network/proxy and retry Refresh data. No write was attempted by this request." : "Write outcome is unknown; reconcile the pending operation before retrying. This write was not automatically retried."}`);
    // Retry only reads. A lost response to a seat/reset write may already have
    // applied remotely, so its durable intent must be reconciled by the engine.
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try { response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(25000) }, proxy); }
      catch (error) {
        if (read && attempt === 0 && networkFailure(error).retryable) { await pause(); continue; }
        throw failure(error);
      }
      if (read && attempt === 0 && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel(); await pause(); continue;
      }
      if (!response.ok) {
        if (admin && response.status === 403 && response.headers?.get("cf-mitigated") === "challenge") {
          throw new Error(`${label}: Cloudflare blocked the request (HTTP 403). Open Claude in the admin browser to check access, then retry Refresh data. OAuth reconnect does not replace the admin web session.`);
        }
        if (admin && response.status === 401) throw new Error(`${label}: web session expired (HTTP 401). Update the admin web session in Settings; OAuth reconnect is separate.`);
        if (admin && response.status === 403) throw new Error(`${label}: access denied (HTTP 403). Check the selected admin, organization and admin web session in Settings.`);
        throw new Error(`${label}: Claude API HTTP ${response.status}`);
      }
      try { return await response.json(); }
      catch (error) {
        if (networkFailure(error).retryable) {
          if (read && attempt === 0) { await pause(); continue; }
          throw failure(error);
        }
        throw new Error(`${label}: Claude returned invalid JSON${read ? "" : "; reconcile the pending operation before retrying the write"}`);
      }
    }
  }
  const webHeaders = {
    Cookie: `sessionKey=${sessionKey}; sessionKeyV3=${sessionKey}`,
    Accept: "application/json", "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    "anthropic-client-platform": "web_claude_ai", "anthropic-client-version": "1.0.0",
    Referer: "https://claude.ai/admin-settings/billing",
  };
  const web = (path, options = {}) => json(`https://claude.ai/api/${path}`, { ...options,
    headers: { ...webHeaders, ...(options.method === "PUT" ? { Origin: "https://claude.ai", Referer: "https://claude.ai/admin-settings/members" } : {}) },
  });
  const orgPath = (org, suffix) => {
    if (!/^[a-f0-9-]{36}$/.test(org)) throw new Error("Invalid organization ID");
    return `organizations/${org}/${suffix}`;
  };
  async function credentials(connection, forceRefresh = false) {
    const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const { connection: current } = await refreshAndUpdateCredentials(connection, forceRefresh, proxy);
    return { current, proxy, headers: {
      Authorization: `Bearer ${current.accessToken}`, "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01", "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`, "Content-Type": "application/json",
    } };
  }
  return {
    account: () => web("account"),
    subscription: (org) => web(orgPath(org, "subscription_details")),
    counts: (org) => web(orgPath(org, "members/counts")),
    async members(org) {
      const members = [];
      for (let offset = 0; offset < 10000; offset += 100) {
        const data = await web(orgPath(org, `members_v2?limit=100&offset=${offset}`));
        if (!Array.isArray(data.data) || !data.pagination || typeof data.pagination.has_more !== "boolean") throw new Error("Invalid member response");
        members.push(...data.data.map((x) => x.member).filter(Boolean));
        if (!data.pagination.has_more) return members;
      }
      throw new Error("Member pagination exceeded limit");
    },
    async setSeat(org, memberId, tier) {
      if (!/^[a-f0-9-]{36}$/.test(memberId) || !["unassigned", "team_standard", "team_tier_1"].includes(tier)) throw new Error("Invalid seat assignment");
      return web(orgPath(org, `members/${memberId}`), { method: "PUT", body: JSON.stringify({ seat_tier: tier }) });
    },
    async profile(connection) {
      const { headers, proxy } = await credentials(connection);
      return json("https://api.anthropic.com/api/oauth/profile", { headers }, proxy);
    },
    async usage(connection, { forceRefresh = false } = {}) {
      const { headers, proxy } = await credentials(connection, forceRefresh);
      return json("https://api.anthropic.com/api/oauth/usage?cedar_ember=1", { headers }, proxy);
    },
    async reset(connection, org, grantId, requestId) {
      const { headers, proxy } = await credentials(connection);
      const data = await json(`https://api.anthropic.com/api/${orgPath(org, "reset_rate_limits")}`, {
        method: "POST", headers, body: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: requestId }),
      }, proxy);
      if (data.result !== "reset") throw new Error("Claude did not confirm limit reset");
      return data;
    },
  };
}
