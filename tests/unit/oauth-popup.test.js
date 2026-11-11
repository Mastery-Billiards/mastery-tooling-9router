import { describe, it, expect, vi } from "vitest";
import { openOAuthPopup } from "../../src/shared/utils/oauthPopup.js";

describe("OAuth popup navigation", () => {
  it("requests a popup with a fresh target for each login, never an existing named window or ordinary tab", () => {
    const browser = { open: vi.fn(() => ({})) };
    openOAuthPopup(browser, "https://claude.ai/oauth/authorize?state=one");
    openOAuthPopup(browser, "https://claude.ai/oauth/authorize?state=two");
    const [first, second] = browser.open.mock.calls;
    expect(first[0]).toContain("state=one");
    expect(first[1]).toMatch(/^9router-oauth-/); expect(first[1]).not.toBe(second[1]);
    expect(first[2]).toContain("popup=yes"); expect(first[2]).toContain("width=600,height=700");
    expect(browser.open.mock.calls.flat()).not.toContain("_blank");
    expect(browser.open.mock.calls.flat()).not.toContain("oauth_popup");
  });
  it("returns a blocked popup without navigating elsewhere or opening a fallback tab", () => {
    const browser = { open: vi.fn(() => null) };
    expect(openOAuthPopup(browser, "https://claude.ai/oauth/authorize")).toBeNull();
    expect(browser.open).toHaveBeenCalledOnce();
  });
});
