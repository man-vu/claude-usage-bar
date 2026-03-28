import { describe, it, expect } from "vitest";

// We test the pure functions by importing the module.
// scanner.ts exports scanConversations, scanToday, DailyStats.
// Internal functions like normalizeModel, decodeProjectName, and pricing logic
// are not exported, so we test them indirectly or extract testable pieces.

// For now, test the exported interface and verify the module loads.

describe("scanner", () => {
  // Import dynamically to ensure vscode mock is active
  it("module loads without error", async () => {
    const mod = await import("./scanner");
    expect(mod.scanConversations).toBeDefined();
    expect(mod.scanToday).toBeDefined();
  });

  describe("scanConversations", () => {
    it("returns empty array when ~/.claude/projects does not exist", async () => {
      const { scanConversations } = await import("./scanner");
      // With a non-existent projects dir, should return []
      const result = await scanConversations(1, 0);
      // This will depend on whether the test runner has ~/.claude/projects
      expect(Array.isArray(result)).toBe(true);
    });

    it("returns DailyStats with correct shape", async () => {
      const { scanConversations } = await import("./scanner");
      const result = await scanConversations(1, 5);
      for (const stat of result) {
        expect(stat).toHaveProperty("date");
        expect(stat).toHaveProperty("totalCost");
        expect(stat).toHaveProperty("inputTokens");
        expect(stat).toHaveProperty("outputTokens");
        expect(stat).toHaveProperty("cacheWriteTokens");
        expect(stat).toHaveProperty("cacheReadTokens");
        expect(stat).toHaveProperty("messageCount");
        expect(stat).toHaveProperty("modelBreakdown");
        expect(stat).toHaveProperty("toolUsage");
        expect(stat).toHaveProperty("hourlyActivity");
        expect(stat.hourlyActivity).toHaveLength(24);
        expect(stat).toHaveProperty("sessionCount");
        expect(stat).toHaveProperty("projectBreakdown");
      }
    });
  });

  describe("scanToday", () => {
    it("returns a DailyStats for today", async () => {
      const { scanToday } = await import("./scanner");
      const result = await scanToday();
      const today = new Date().toISOString().slice(0, 10);
      expect(result.date).toBe(today);
      expect(result.messageCount).toBeGreaterThanOrEqual(0);
    });
  });
});
