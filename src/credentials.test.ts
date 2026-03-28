import { describe, it, expect } from "vitest";

describe("credentials", () => {
  it("module loads and exports getCredentials", async () => {
    const mod = await import("./credentials");
    expect(mod.getCredentials).toBeDefined();
  });

  it("getCredentials returns null or valid credentials", async () => {
    const { getCredentials } = await import("./credentials");
    const result = await getCredentials();
    // On CI or machines without Claude Code, this returns null
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
      expect(result).toHaveProperty("expiresAt");
      expect(result).toHaveProperty("subscriptionType");
      expect(result).toHaveProperty("rateLimitTier");
    }
  });
});
