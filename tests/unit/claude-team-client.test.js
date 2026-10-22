import { describe, expect, it, vi } from "vitest";
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => null) }));
vi.mock("@/app/api/usage/[connectionId]/route", () => ({ refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection })) }));
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route";
import { createTeamClient } from "../../src/lib/claudeTeam/client.js";
const org = "71f09ff4-2c3e-44da-91de-7917610a646d";
const response = (data) => ({ ok: true, json: async () => data });

describe("Claude Team API client", () => {
  it("uses the web session for admin endpoints and follows member pagination", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ data: [{ member: { account: { uuid: "one" } } }], pagination: { has_more: true } }))
      .mockResolvedValueOnce(response({ data: [{ member: { account: { uuid: "two" } } }], pagination: { has_more: false } }));
    const client = createTeamClient("test-session", null, fetch);
    expect((await client.members(org)).map((m) => m.account.uuid)).toEqual(["one", "two"]);
    expect(fetch.mock.calls[0][1].headers.Cookie).toContain("sessionKey=test-session");
    expect(fetch.mock.calls[1][0]).toContain("offset=100");
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });
  it("forces credential refresh when checking a newly assigned account", async () => {
    const fetch = vi.fn(async () => response({}));
    const client = createTeamClient("web", null, fetch);
    const connection = { id: "account", accessToken: "oauth-test" };
    await client.usage(connection, { forceRefresh: true });
    expect(refreshAndUpdateCredentials).toHaveBeenCalledWith(connection, true, null);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer oauth-test");
    expect(fetch.mock.calls[0][1].headers.Cookie).toBeUndefined();
  });
  it("does not expose remote errors or credentials in thrown messages", async () => {
    const client = createTeamClient("private-session", null, vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ secret: "private-session" }) })));
    await expect(client.account()).rejects.toThrow("access denied (HTTP 403)");
  });
  it("distinguishes Cloudflare challenges from OAuth and session failures", async () => {
    const client = createTeamClient("private-session", null, vi.fn(async () => ({ ok: false, status: 403, headers: new Headers({ "cf-mitigated": "challenge" }) })));
    await expect(client.account()).rejects.toThrow("Cloudflare blocked");
    await expect(client.usage({ id: "member", accessToken: "oauth" })).rejects.toThrow("Claude API HTTP 403");
    const expired = createTeamClient("private-session", null, vi.fn(async () => ({ ok: false, status: 401 })));
    await expect(expired.account()).rejects.toThrow("web session expired");
  });
  it("matches the captured seat PUT origin and sends only the seat tier", async () => {
    const fetch = vi.fn(async () => response({})); const client = createTeamClient("web", null, fetch);
    await client.setSeat(org, org, "team_standard");
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`https://claude.ai/api/organizations/${org}/members/${org}`);
    expect(options.headers.Origin).toBe("https://claude.ai");
    expect(options.headers.Referer).toBe("https://claude.ai/admin-settings/members");
    expect(JSON.parse(options.body)).toEqual({ seat_tier: "team_standard" });
  });
  it("rejects arbitrary orgs, member IDs and seat tiers before sending", async () => {
    const fetch = vi.fn(); const client = createTeamClient("web", null, fetch);
    expect(() => client.counts("../../other-host")).toThrow();
    await expect(client.setSeat(org, org, "purchase-more")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});


it("retries a transient GET transport failure with a fresh timeout signal", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn().mockRejectedValueOnce(Object.assign(new Error("private remote detail"), { cause: { code: "ECONNRESET" } })).mockResolvedValueOnce(response({ ok: true }));
    const result = createTeamClient("private-session", null, fetch).account();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].signal).not.toBe(fetch.mock.calls[1][1].signal);
  } finally { vi.useRealTimers(); }
});

it("reports endpoint and safe network cause after bounded read retries", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn().mockRejectedValue(Object.assign(new Error("private-session"), { cause: { code: "ENOTFOUND" } }));
    const assertion = expect(createTeamClient("private-session", null, fetch).account()).rejects.toThrow("Claude admin account: network error (ENOTFOUND). Read request failed");
    await vi.runAllTimersAsync(); await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it("never replays seat or reset writes after a timeout or a lost body", async () => {
  const fetch = vi.fn().mockRejectedValue(Object.assign(new Error("private-session"), { name: "TimeoutError" }));
  const client = createTeamClient("private-session", null, fetch);
  await expect(client.setSeat(org, org, "team_standard")).rejects.toThrow("Write outcome is unknown; reconcile the pending operation");
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockClear();
  await expect(client.reset({ accessToken: "private-token" }, org, "grant", "request")).rejects.toThrow("write was not automatically retried");
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockClear(); fetch.mockResolvedValue({ ok: true, json: async () => { throw Object.assign(new Error("private"), { cause: { code: "UND_ERR_SOCKET" } }); } });
  await expect(client.setSeat(org, org, "unassigned")).rejects.toThrow("Write outcome is unknown");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retries read gateway errors but never retries authentication or Cloudflare failures", async () => {
  vi.useFakeTimers();
  try {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(response({}));
    const result = createTeamClient("private-session", null, fetch).account();
    await vi.runAllTimersAsync(); await result;
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const status of [401, 403]) {
      fetch.mockClear(); fetch.mockResolvedValue({ ok: false, status, headers: new Headers({ "cf-mitigated": "challenge" }) });
      await expect(createTeamClient("private-session", null, fetch).account()).rejects.toThrow(`HTTP ${status}`);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  } finally { vi.useRealTimers(); }
});
