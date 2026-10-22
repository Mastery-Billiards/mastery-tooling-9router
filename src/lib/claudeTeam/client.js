import "open-sse/index.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route";
import { CLAUDE_CLI_VERSION } from "open-sse/providers/shared.js";

export function createTeamClient(sessionKey, adminProxy = null, fetcher = proxyAwareFetch) {
  async function json(url, options = {}, proxy = adminProxy) {
    let response;
    try { response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(25000) }, proxy); }
    catch { throw new Error("Claude request failed or timed out; reconcile before retrying writes"); }
    if (!response.ok) throw new Error(`Claude API HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error("Claude returned invalid JSON"); }
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
