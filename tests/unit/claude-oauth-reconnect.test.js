import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), fetch: vi.fn(), lock: vi.fn(), unlock: vi.fn(), storeGet: vi.fn(), storeSet: vi.fn(), proxy: vi.fn() }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: m.fetch }));
vi.mock("@/lib/localDb", () => ({ getProviderConnectionById: m.get, updateProviderConnection: m.update }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: m.proxy }));
vi.mock("@/lib/claudeTeam/store", () => ({ acquireTeamLock: m.lock, teamStore: { get: m.storeGet, set: m.storeSet } }));
import { reconnectClaude } from "../../src/lib/oauth/reconnectClaude.js";

let connection, state, exchange;
beforeEach(() => {
  vi.resetAllMocks();
  connection = { id: "c", provider: "claude", authType: "oauth", name: "Custom label", isActive: false, priority: 7, accessToken: "old", providerSpecificData: { connectionProxyPoolId: "pool" } };
  state = { members: { c: { memberId: "account", email: "member@example.org", seatTier: "unassigned", snapshot: { weekly: { remaining: 40 } }, error: "401", identityVerified: false } }, history: [{ id: "prior" }] };
  m.get.mockImplementation(async () => structuredClone(connection));
  m.update.mockImplementation(async (id, patch) => ({ ...connection, ...patch, id }));
  m.lock.mockResolvedValue(m.unlock);
  m.storeGet.mockImplementation(async (key) => structuredClone(key === "state" ? state : { orgId: "org" }));
  m.proxy.mockResolvedValue({ connectionProxyPoolId: "pool" });
  m.fetch.mockResolvedValue({ ok: true, json: async () => ({ account: { uuid: "account", email: "member@example.org" }, organization: { uuid: "org" } }) });
  exchange = vi.fn(async () => ({ accessToken: "new", refreshToken: "refresh", expiresIn: 3600 }));
});
describe("Claude OAuth reconnect", () => {
  it("replaces credentials in place, preserves disabled routing/settings and updates shared Team identity without losing quota/history", async () => {
    const result = await reconnectClaude("c", exchange);
    expect(result).toMatchObject({ id: "c", isActive: false, priority: 7, name: "Custom label", accessToken: "new", email: "member@example.org", providerSpecificData: { connectionProxyPoolId: "pool", claudeAccountId: "account" } });
    const patch = m.update.mock.calls[0][1];
    expect(patch).not.toHaveProperty("isActive"); expect(patch).not.toHaveProperty("priority"); expect(patch).not.toHaveProperty("name");
    expect(m.storeSet.mock.calls[0][1]).toMatchObject({ members: { c: { identityVerified: true, error: null, seatTier: "unassigned", snapshot: { weekly: { remaining: 40 } } } } });
    expect(m.storeSet.mock.calls[0][1].history).toHaveLength(2);
    expect(m.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer new");
    expect(m.fetch.mock.calls[0][2]).toEqual({ connectionProxyPoolId: "pool" });
    expect(m.unlock).toHaveBeenCalledOnce();
  });
  it("rejects the wrong account even if its email is the same", async () => {
    m.fetch.mockResolvedValue({ ok: true, json: async () => ({ account: { uuid: "other", email: "member@example.org" }, organization: { uuid: "org" } }) });
    await expect(reconnectClaude("c", exchange)).rejects.toThrow("Wrong Claude account");
    expect(m.update).not.toHaveBeenCalled(); expect(m.storeSet).not.toHaveBeenCalled(); expect(m.unlock).toHaveBeenCalledOnce();
  });
  it("rejects a different selected organization without saving credentials", async () => {
    m.fetch.mockResolvedValue({ ok: true, json: async () => ({ account: { uuid: "account" }, organization: { uuid: "other" } }) });
    await expect(reconnectClaude("c", exchange)).rejects.toThrow("same Claude Team organization");
    expect(m.update).not.toHaveBeenCalled();
  });
  it("does not consume an authorization code while a worker or seat transaction owns the account", async () => {
    m.lock.mockResolvedValueOnce(null);
    await expect(reconnectClaude("c", exchange)).rejects.toThrow("busy");
    state.pending = { sourceId: "c", targetId: "other" };
    await expect(reconnectClaude("c", exchange)).rejects.toThrow("pending seat operation");
    expect(exchange).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
  it("never trusts an editable display name when old credentials cannot identify a legacy connection", async () => {
    state.members = {}; connection.name = "member@example.org";
    m.fetch.mockResolvedValue({ ok: false });
    await expect(reconnectClaude("c", exchange)).rejects.toThrow("No verified identity");
    expect(exchange).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
  it("can verify a legacy connection from its still-readable old profile", async () => {
    state.members = {};
    await reconnectClaude("c", exchange);
    expect(m.fetch).toHaveBeenCalledTimes(2);
    expect(m.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer old");
    expect(m.update).toHaveBeenCalledOnce();
  });
  it("rejects provider mismatch before exchanging credentials", async () => {
    connection.provider = "codex";
    await expect(reconnectClaude("c", exchange)).rejects.toThrow("not found");
    expect(exchange).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
});
