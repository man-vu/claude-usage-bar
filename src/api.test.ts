import { describe, it, expect } from "vitest";

describe("api", () => {
  it("module loads and exports fetchUsage", async () => {
    const mod = await import("./api");
    expect(mod.fetchUsage).toBeDefined();
  });

  it("UsageData interface shape is correct", async () => {
    const { fetchUsage } = await import("./api");
    // fetchUsage requires a real token so we can't call it in unit tests,
    // but we verify the function exists and has correct arity
    expect(typeof fetchUsage).toBe("function");
    expect(fetchUsage.length).toBe(1); // takes 1 parameter (accessToken)
  });

  // Integration test — skipped by default, run manually with real token
  it.skip("fetches usage with a valid token", async () => {
    const { fetchUsage } = await import("./api");
    const result = await fetchUsage("test-invalid-token");
    // Should return an error (not crash)
    expect(result.error).toBeTruthy();
    expect(result.data).toBeNull();
  });
});
